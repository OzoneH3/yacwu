//// Scriptable stand-in for a persistent `codex app-server --listen unix://…`.
////
//// Unlike `ws_stub`, nothing is answered automatically except (optionally)
//// `initialize`: every frame the manager writes is reported to the test,
//// which decides what to send back and when — replies, errors, late replies,
//// notifications — or drops the connection.

import gleam/bit_array
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/erlang/atom
import gleam/erlang/process.{type Subject}
import gleam/json
import gleam/list
import gleam/option.{None}
import gleam/result
import gleam/string
import simplifile
import yacwu/ws

pub type Socket

type TcpOption {
  Binary
  Active(Bool)
  Ifaddr(NetAddress)
}

type NetAddress {
  Local(String)
}

@external(erlang, "gen_tcp", "listen")
fn tcp_listen(port: Int, options: List(TcpOption)) -> Result(Socket, Dynamic)

@external(erlang, "gen_tcp", "accept")
fn tcp_accept(socket: Socket, timeout: Int) -> Result(Socket, Dynamic)

@external(erlang, "gen_tcp", "recv")
fn tcp_recv(
  socket: Socket,
  length: Int,
  timeout: Int,
) -> Result(BitArray, Dynamic)

@external(erlang, "gen_tcp", "send")
fn tcp_send(socket: Socket, data: BitArray) -> Dynamic

@external(erlang, "gen_tcp", "close")
fn tcp_close(socket: Socket) -> Dynamic

/// One frame the manager wrote. `id` is -1 for notifications.
pub type Frame {
  Frame(id: Int, method: String, text: String)
}

pub type Event {
  Attached
  Got(Frame)
}

pub type Control {
  /// Send raw JSON text to the manager on the current connection.
  SendText(String)
  /// Drop the current connection (keep listening).
  Kill
  Stop
}

/// Start the stub. With `auto_init`, `initialize` is answered at once;
/// otherwise the test answers it (or never does).
pub fn start(
  path: String,
  events: Subject(Event),
  auto_init: Bool,
) -> Subject(Control) {
  let ready = process.new_subject()
  let _ =
    process.spawn(fn() {
      let _ = simplifile.delete(path)
      let assert Ok(listener) =
        tcp_listen(0, [Binary, Active(False), Ifaddr(Local(path))])
      let control = process.new_subject()
      process.send(ready, control)
      accept_loop(listener, events, control, auto_init)
    })
  let assert Ok(control) = process.receive(ready, 5000)
  control
}

/// Answer request `id` with `result`.
pub fn reply(control: Subject(Control), id: Int, result: json.Json) -> Nil {
  process.send(
    control,
    SendText(
      json.to_string(json.object([#("id", json.int(id)), #("result", result)])),
    ),
  )
}

/// Answer request `id` with a JSON-RPC error.
pub fn reply_error(
  control: Subject(Control),
  id: Int,
  code: Int,
  message: String,
) -> Nil {
  process.send(
    control,
    SendText(
      json.to_string(
        json.object([
          #("id", json.int(id)),
          #(
            "error",
            json.object([
              #("code", json.int(code)),
              #("message", json.string(message)),
            ]),
          ),
        ]),
      ),
    ),
  )
}

/// Send a notification.
pub fn notify(control: Subject(Control), method: String, params: json.Json) {
  process.send(
    control,
    SendText(
      json.to_string(
        json.object([#("method", json.string(method)), #("params", params)]),
      ),
    ),
  )
}

/// Wait for the next frame with `method`, skipping others.
pub fn expect(
  events: Subject(Event),
  method: String,
  timeout: Int,
) -> Result(Frame, Nil) {
  case process.receive(events, timeout) {
    Error(_) -> Error(Nil)
    Ok(Got(frame)) if frame.method == method -> Ok(frame)
    Ok(_) -> expect(events, method, timeout)
  }
}

/// Every frame with `method` received within `window` ms.
pub fn collect(
  events: Subject(Event),
  method: String,
  window: Int,
) -> List(Frame) {
  collect_loop(events, method, window, [])
}

fn collect_loop(events, method, window, acc) {
  case process.receive(events, window) {
    Error(_) -> list.reverse(acc)
    Ok(Got(frame)) if frame.method == method ->
      collect_loop(events, method, window, [frame, ..acc])
    Ok(_) -> collect_loop(events, method, window, acc)
  }
}

fn accept_loop(listener, events, control, auto_init) -> Nil {
  case process.receive(control, 0) {
    Ok(Stop) -> {
      let _ = tcp_close(listener)
      Nil
    }
    Ok(_) -> accept_loop(listener, events, control, auto_init)
    Error(_) ->
      case tcp_accept(listener, 100) {
        Error(_) -> accept_loop(listener, events, control, auto_init)
        Ok(client) -> {
          case handshake(client) {
            Ok(leftover) -> {
              process.send(events, Attached)
              serve(
                client,
                ws.new_decoder(),
                leftover,
                events,
                control,
                auto_init,
              )
            }
            Error(_) -> {
              let _ = tcp_close(client)
              Nil
            }
          }
          accept_loop(listener, events, control, auto_init)
        }
      }
  }
}

fn handshake(client: Socket) -> Result(BitArray, Nil) {
  use #(header, leftover) <- result.try(read_header(client, <<>>, 20))
  use key <- result.try(
    string.split(header, "\r\n")
    |> list.find_map(fn(line) {
      case string.split_once(line, ":") {
        Ok(#(name, value)) ->
          case string.lowercase(string.trim(name)) == "sec-websocket-key" {
            True -> Ok(string.trim(value))
            False -> Error(Nil)
          }
        Error(_) -> Error(Nil)
      }
    }),
  )
  let response =
    "HTTP/1.1 101 Switching Protocols\r\n"
    <> "Upgrade: websocket\r\n"
    <> "Connection: Upgrade\r\n"
    <> "Sec-WebSocket-Accept: "
    <> ws.accept_key(key)
    <> "\r\n\r\n"
  let _ = tcp_send(client, bit_array.from_string(response))
  Ok(leftover)
}

fn read_header(client, buffer, attempts) -> Result(#(String, BitArray), Nil) {
  case ws.split_header(buffer) {
    Ok(split) -> Ok(split)
    Error(_) ->
      case attempts <= 0 {
        True -> Error(Nil)
        False ->
          case tcp_recv(client, 0, 5000) {
            Error(_) -> Error(Nil)
            Ok(data) ->
              read_header(
                client,
                bit_array.concat([buffer, data]),
                attempts - 1,
              )
          }
      }
  }
}

fn serve(client, decoder, data, events, control, auto_init) -> Nil {
  let #(frames, decoder) = ws.push(decoder, data)
  let closed =
    list.any(frames, fn(frame) {
      case frame {
        ws.Text(text) -> {
          handle_text(client, text, events, auto_init)
          False
        }
        ws.Ping(payload) -> {
          let _ = tcp_send(client, ws.encode(ws.Pong(payload), None))
          False
        }
        ws.Close -> True
        _ -> False
      }
    })
  case closed {
    True -> {
      let _ = tcp_close(client)
      Nil
    }
    False -> drain_control(client, decoder, events, control, auto_init)
  }
}

fn drain_control(client, decoder, events, control, auto_init) -> Nil {
  case process.receive(control, 0) {
    Ok(SendText(text)) -> {
      let _ = tcp_send(client, ws.encode(ws.Text(text), None))
      drain_control(client, decoder, events, control, auto_init)
    }
    Ok(Kill) | Ok(Stop) -> {
      let _ = tcp_close(client)
      Nil
    }
    Error(_) ->
      case tcp_recv(client, 0, 20) {
        Ok(data) -> serve(client, decoder, data, events, control, auto_init)
        Error(reason) ->
          case
            decode.run(reason, atom.decoder()) == Ok(atom.create("timeout"))
          {
            True -> serve(client, decoder, <<>>, events, control, auto_init)
            False -> {
              let _ = tcp_close(client)
              Nil
            }
          }
      }
  }
}

fn handle_text(client, text: String, events, auto_init: Bool) -> Nil {
  let method =
    json.parse(text, decode.at(["method"], decode.string)) |> result.unwrap("")
  let id = json.parse(text, decode.at(["id"], decode.int)) |> result.unwrap(-1)
  case method, auto_init {
    "initialize", True -> {
      let reply =
        json.object([#("id", json.int(id)), #("result", json.object([]))])
      let _ = tcp_send(client, ws.encode(ws.Text(json.to_string(reply)), None))
      Nil
    }
    _, _ -> Nil
  }
  process.send(events, Got(Frame(id, method, text)))
}

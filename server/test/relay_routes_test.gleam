//// Relay routes over real HTTP through the real router and gate: agent
//// routes take only the relay bearer credential; browser routes take only
//// browser authentication.

import gleam/erlang/process
import gleam/http
import gleam/http/request
import gleam/httpc
import gleam/int
import gleam/option.{None}
import gleeunit/should
import mist
import yacwu/auth
import yacwu/relay
import yacwu/relay_core
import yacwu/router

const credential = "relay-test-credential"

/// Serve the router with `conf` on an ephemeral port.
fn serve(conf: auth.Config) -> Int {
  let relay_name: relay.Relay = process.new_name("relay_routes")
  let assert Ok(_) =
    relay.start(
      relay_name,
      relay.Backends(
        resolve: fn(_) { Error("no backends") },
        subscribe: fn(_, _) { Nil },
      ),
      relay_core.default_limits(),
      relay.default_timeouts(),
    )
  let ctx =
    router.Context(
      registry: process.new_name("relay_routes_registry"),
      store: process.new_name("relay_routes_store"),
      profile_store: process.new_name("relay_routes_profiles"),
      static_dir: "",
      auth: conf,
      relay: relay_name,
      relay_credential: credential,
    )
  let bound = process.new_subject()
  let assert Ok(_) =
    mist.new(router.handler(ctx))
    |> mist.bind("127.0.0.1")
    |> mist.port(0)
    |> mist.after_start(fn(port, _, _) { process.send(bound, port) })
    |> mist.start
  let assert Ok(port) = process.receive(bound, 5000)
  port
}

fn status(
  port: Int,
  method: http.Method,
  path: String,
  headers: List(#(String, String)),
  body: String,
) -> Int {
  let assert Ok(req) =
    request.to("http://127.0.0.1:" <> int.to_string(port) <> path)
  let req =
    req
    |> request.set_method(method)
    |> request.set_body(body)
    |> request.set_header("content-type", "application/json")
  let req =
    headers
    |> list_fold(req, fn(req, header) {
      request.set_header(req, header.0, header.1)
    })
  let assert Ok(resp) = httpc.send(req)
  resp.status
}

fn list_fold(items: List(a), acc: b, f: fn(b, a) -> b) -> b {
  case items {
    [] -> acc
    [first, ..rest] -> list_fold(rest, f(acc, first), f)
  }
}

const bearer = #("authorization", "Bearer relay-test-credential")

const browser = #("remote-user", "alice")

fn forward_auth() -> auth.Config {
  auth.Config(remote_users: ["alice"], oauth: None, insecure_skip_auth: False)
}

pub fn agent_route_accepts_only_the_bearer_test() {
  let port = serve(forward_auth())
  status(port, http.Get, "/api/relay/inbox?session=thr-x", [bearer], "")
  |> should.equal(200)
  status(port, http.Get, "/api/relay/inbox?session=thr-x", [], "")
  |> should.equal(401)
  // Browser authentication alone does not open agent routes.
  status(port, http.Get, "/api/relay/inbox?session=thr-x", [browser], "")
  |> should.equal(401)
  status(
    port,
    http.Get,
    "/api/relay/inbox?session=thr-x",
    [#("authorization", "Bearer wrong")],
    "",
  )
  |> should.equal(401)
}

pub fn browser_log_accepts_only_browser_auth_test() {
  let port = serve(forward_auth())
  status(port, http.Get, "/api/threads/thr-x/relay", [browser], "")
  |> should.equal(200)
  status(port, http.Get, "/api/threads/thr-x/relay", [bearer], "")
  |> should.equal(401)
}

pub fn bearer_cannot_change_settings_test() {
  let port = serve(forward_auth())
  let body = "{\"enabled\":false}"
  status(port, http.Post, "/api/threads/thr-x/relay/settings", [bearer], body)
  |> should.equal(401)
  status(port, http.Post, "/api/threads/thr-x/relay/settings", [browser], body)
  |> should.equal(200)
}

/// With authentication bypassed the settings route is open to any local
/// caller (documented); the agent routes still demand the credential.
pub fn bypass_mode_test() {
  let port =
    serve(auth.Config(remote_users: [], oauth: None, insecure_skip_auth: True))
  status(
    port,
    http.Post,
    "/api/threads/thr-x/relay/settings",
    [],
    "{\"enabled\":true}",
  )
  |> should.equal(200)
  status(port, http.Get, "/api/relay/inbox?session=thr-x", [], "")
  |> should.equal(401)
}

pub fn relay_authorized_test() {
  router.relay_authorized(Ok("Bearer abc"), "abc") |> should.be_true
  router.relay_authorized(Ok("bearer  abc "), "abc") |> should.be_true
  router.relay_authorized(Ok("Bearer abcd"), "abc") |> should.be_false
  router.relay_authorized(Ok("Basic abc"), "abc") |> should.be_false
  router.relay_authorized(Error(Nil), "abc") |> should.be_false
  // An empty credential disables the routes rather than matching "".
  router.relay_authorized(Ok("Bearer "), "") |> should.be_false
}

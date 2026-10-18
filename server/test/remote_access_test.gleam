import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/result
import gleeunit/should
import simplifile
import yacwu/jsonx
import yacwu/oauth
import yacwu/remote_access

@external(erlang, "yacwu_ssh_access", "host_id")
fn host_id(host: String) -> String

pub fn managed_identity_and_expiry_test() {
  let host = "yacwu-unit-test@host"
  let dir = remote_access.root() <> "/" <> host_id(host)
  let assert Ok(_) = simplifile.create_directory_all(dir)
  let write = fn(at) {
    simplifile.write(
      dir <> "/entry.json",
      json.to_string(
        json.object([
          #("host", json.string(host)),
          #("hostname", json.string("example.test")),
          #("username", json.string("tester")),
          #("port", json.int(2222)),
          #("expiresAt", json.int(at)),
        ]),
      ),
    )
  }
  let expires = { oauth.now() + 100 } * 1000
  let assert Ok(_) = write(expires)
  remote_access.check(host) |> should.equal(Ok(Nil))
  list.contains(remote_access.discover(), host) |> should.be_true
  let args = remote_access.arguments(host)
  list.contains(args, "-oHostName=example.test") |> should.be_true
  list.contains(args, "-oIdentityAgent=none") |> should.be_true
  list.contains(args, dir <> "/id_ed25519") |> should.be_true
  remote_access.expires_at(host) |> should.equal(expires)
  let assert Ok(_) = write({ oauth.now() - 1 } * 1000)
  remote_access.check(host) |> result.is_error |> should.be_true
  let assert Ok(_) = simplifile.write(dir <> "/entry.json", "bad-json")
  remote_access.check(host) |> result.is_error |> should.be_true
  let _ = simplifile.delete(dir)
  remote_access.arguments("unmanaged") |> should.equal([])
}

pub fn helper_stdin_protocol_and_validation_test() {
  let assert Ok(input) =
    json.parse(
      "{\"action\":\"revoke\",\"hostname\":\"-bad\",\"username\":\"user\",\"password\":\"do-not-echo-this\"}",
      decode.dynamic,
    )
  let assert Ok(output) = remote_access.operation(input, "setup")
  jsonx.field_string(output, ["error"])
  |> should.equal(Ok("Enter a valid hostname and username."))
}

@external(erlang, "yacwu_ssh_access_test_ffi", "forwarder_expires")
fn forwarder_expires(wrapper: String) -> Bool

pub fn existing_tunnel_closes_at_expiry_test() {
  let host = "yacwu-expiring-test@host"
  let dir = remote_access.root() <> "/" <> host_id(host)
  let assert Ok(_) = simplifile.create_directory_all(dir)
  let assert Ok(_) =
    simplifile.write(
      dir <> "/entry.json",
      json.to_string(
        json.object([
          #("host", json.string(host)),
          #("expiresAt", json.int({ oauth.now() + 2 } * 1000)),
        ]),
      ),
    )
  let result = forwarder_expires(remote_access.tunnel_wrapper(host))
  let _ = simplifile.delete(dir)
  result |> should.be_true
}

-module(yacwu_ssh_access).
-export([run/2, host_id/1]).

host_id(Host) -> binary:encode_hex(crypto:hash(sha256, Host)).

%% Secret request is sent over stdin. Never include input or helper output in
%% errors/diagnostics. A deadline bounds password prompts and remote commands.
run(Script, Input) ->
    case os:find_executable("node") of
        false -> {error, <<"Node.js is required for password-assisted SSH setup">>};
        Node ->
            Port = open_port({spawn_executable, Node},
                [binary, exit_status, use_stdio, hide,
                 {args, [binary_to_list(Script)]}]),
            port_command(Port, <<Input/binary, "\n">>),
            collect(Port, <<>>, erlang:monotonic_time(millisecond) + 120000)
    end.

collect(Port, Output, Deadline) ->
    Remaining = max(0, Deadline - erlang:monotonic_time(millisecond)),
    receive
        {Port, {data, Data}} when byte_size(Output) + byte_size(Data) =< 32768 ->
            collect(Port, <<Output/binary, Data/binary>>, Deadline);
        {Port, {data, _}} ->
            catch port_close(Port), {error, <<"SSH setup returned too much output">>};
        {Port, {exit_status, 0}} -> {ok, Output};
        {Port, {exit_status, _}} -> {error, <<"SSH setup helper failed">>}
    after Remaining ->
        catch port_close(Port), {error, <<"SSH setup timed out">>}
    end.

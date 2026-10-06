-module(yacwu_usage).
-export([path/1, append/2, read/1, read_all/0, fingerprint/1, now/0]).
-include_lib("kernel/include/file.hrl").

now() -> erlang:system_time(millisecond).

fingerprint(Value) -> binary:encode_hex(crypto:hash(sha256, Value)).

path(Label) ->
    State = os:getenv("XDG_STATE_HOME", filename:join(os:getenv("HOME", "/tmp"), ".local/state")),
    Dir = os:getenv("YACWU_USAGE_DIR", filename:join(State, "yacwu/usage")),
    unicode:characters_to_binary(filename:join(Dir, "usage-" ++ integer_to_list(erlang:phash2(Label)) ++ ".jsonl")).

%% Each host's manager serializes writes. Telemetry must never interrupt work.
append(Label, Line) ->
    try
        Path = path(Label),
        ok = filelib:ensure_dir(Path),
        ok = file:change_mode(filename:dirname(Path), 8#700),
        case file:read_file_info(Path) of
            {ok, #file_info{size = Size}} when Size >= 20971520 ->
                Previous = <<Path/binary, ".1">>,
                _ = file:delete(Previous),
                ok = file:rename(Path, Previous);
            _ -> ok
        end,
        ok = file:write_file(Path, [Line, "\n"], [append]),
        ok = file:change_mode(Path, 8#600),
        true
    catch _:_ -> false end.

read(Label) ->
    Path = path(Label),
    Read = fun(P) -> case file:read_file(P) of {ok, Bytes} -> Bytes; _ -> <<>> end end,
    <<(Read(<<Path/binary, ".1">>))/binary, (Read(Path))/binary>>.

read_all() ->
    Dir = filename:dirname(path(<<"local">>)),
    case file:list_dir(Dir) of
        {ok, Names} ->
            Read = fun(P) -> case file:read_file(P) of {ok, Bytes} -> <<Bytes/binary, "\n">>; _ -> <<>> end end,
            Parts = [[Read(filename:join(Dir, unicode:characters_to_binary([Name, ".1"]))), Read(filename:join(Dir, Name))]
                     || Name <- lists:sort(Names), re:run(Name, "^usage-[0-9]+\\.jsonl$", [{capture, none}]) =:= match],
            iolist_to_binary(Parts);
        _ -> <<>>
    end.

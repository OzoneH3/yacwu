-module(yacwu_diagnostics).
-export([write/2, paths/1, rotate_stderr/1, process_stats/1]).
-include_lib("kernel/include/file.hrl").
-define(LIMIT, 5242880).

paths(Label) ->
    Home = case os:getenv("XDG_STATE_HOME") of
        false -> filename:join(os:getenv("HOME", "/tmp"), ".local/state");
        State -> State
    end,
    Dir = case os:getenv("YACWU_DIAGNOSTICS_DIR") of
        false -> filename:join(Home, "yacwu/diagnostics");
        Override -> Override
    end,
    Stem = filename:join(Dir, "codex-" ++ integer_to_list(erlang:phash2(Label))),
    {unicode:characters_to_binary(Stem ++ ".jsonl"),
     unicode:characters_to_binary(Stem ++ ".stderr.log")}.

%% Managers serialize their own writes. Failures must never break an RPC.
write(Label, Line) ->
    try
        {Path, _} = paths(Label),
        ok = filelib:ensure_dir(Path),
        ok = file:change_mode(filename:dirname(Path), 8#700),
        rotate(Path, false),
        ok = file:write_file(Path, [Line, "\n"], [append]),
        ok = file:change_mode(Path, 8#600),
        true
    catch _:_ -> log_failure(), false end.

rotate_stderr(Label) ->
    try
        {_, Path} = paths(Label),
        ok = filelib:ensure_dir(Path),
        ok = file:change_mode(filename:dirname(Path), 8#700),
        case filelib:is_file(Path) of
            false -> ok = file:write_file(Path, <<>>);
            true -> ok
        end,
        ok = file:change_mode(Path, 8#600),
        rotate(Path, true),
        true
    catch _:_ -> log_failure(), false end.

rotate(Path, KeepInode) ->
    case file:read_file_info(Path) of
        {ok, #file_info{size = Size}} when Size >= ?LIMIT ->
            Previous = <<Path/binary, ".1">>,
            case KeepInode of
                true ->
                    %% The child retains an append fd: truncate in place.
                    {ok, Fd} = file:open(Path, [read, binary, raw]),
                    {ok, Tail} = file:pread(Fd, max(0, Size - ?LIMIT), ?LIMIT),
                    ok = file:close(Fd),
                    ok = file:write_file(Previous, Tail),
                    ok = file:write_file(Path, <<>>);
                false ->
                    _ = file:delete(Previous),
                    ok = file:rename(Path, Previous)
            end,
            ok = file:change_mode(Previous, 8#600);
        _ -> ok
    end.

%% Linux-only process counters; no command line, environment or task output.
process_stats(Pid) ->
    try
        {ok, Stat} = file:read_file("/proc/" ++ integer_to_list(Pid) ++ "/stat"),
        [_Name, Rest] = binary:split(Stat, <<") ">>),
        Fields = binary:split(string:trim(Rest), <<" ">>, [global, trim_all]),
        #{<<"state">> => lists:nth(1, Fields),
          <<"userCpuTicks">> => binary_to_integer(lists:nth(12, Fields)),
          <<"systemCpuTicks">> => binary_to_integer(lists:nth(13, Fields)),
          <<"threads">> => binary_to_integer(lists:nth(18, Fields)),
          <<"rssPages">> => binary_to_integer(lists:nth(22, Fields))}
    catch _:_ -> nil end.

log_failure() ->
    Now = erlang:monotonic_time(second),
    Last = get(yacwu_diagnostic_failure),
    case Last =:= undefined orelse Now - Last >= 60 of
        true ->
            put(yacwu_diagnostic_failure, Now),
            io:format(standard_error, "[yacwu diagnostics] cannot write logs; check diagnostic directory permissions and disk space~n", []);
        false -> ok
    end.

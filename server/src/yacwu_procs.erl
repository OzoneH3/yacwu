-module(yacwu_procs).
-export([tagged/1]).

%% Processes on this machine whose environment carries
%% YACWU_THREAD_ID=Thread (the Claude wrapper tags each session's Claude
%% process; the commands it starts inherit the tag), as
%% {Pid, ParentPid, Command, ElapsedSeconds, CpuCentiseconds}.
%% Linux /proc only; anything unreadable is skipped.
%% One owner serializes refreshes across concurrent requests. A snapshot is
%% shared by every thread for one second; callers never scan /proc themselves.
tagged(Thread) ->
    Pid = cache_owner(),
    Ref = erlang:monitor(process, Pid),
    Pid ! {snapshot, self(), Ref, Thread},
    receive
        {Ref, Processes} -> erlang:demonitor(Ref, [flush]), Processes;
        {'DOWN', Ref, process, Pid, _} -> tagged(Thread)
    after 5000 -> erlang:demonitor(Ref, [flush]), []
    end.

cache_owner() ->
    case whereis(yacwu_procs_cache) of
        undefined ->
            Pid = spawn(fun() -> receive start -> cache_loop(undefined, #{}) end end),
            try register(yacwu_procs_cache, Pid) of
                true -> Pid ! start, Pid
            catch error:badarg -> exit(Pid, kill), cache_owner()
            end;
        Pid -> Pid
    end.

cache_loop(At, Cached) ->
    receive
        {snapshot, From, Ref, Thread} ->
            Now = erlang:monotonic_time(millisecond),
            {NextAt, Next} = case At =/= undefined andalso Now - At < 1000 of
                true -> {At, Cached};
                false -> {Now, scan()}
            end,
            From ! {Ref, maps:get(Thread, Next, [])},
            cache_loop(NextAt, Next)
    end.

scan() ->
    Uptime = uptime(),
    case file:list_dir("/proc") of
        {ok, Names} ->
            lists:foldl(fun(Name, Acc) ->
                case process(Name, Uptime) of
                    {Thread, Info} -> maps:update_with(Thread, fun(Items) -> [Info | Items] end, [Info], Acc);
                    false -> Acc
                end
            end, #{}, Names);
        _ -> #{}
    end.

process(Name, Uptime) ->
    case string:to_integer(Name) of
        {Pid, []} ->
            Dir = "/proc/" ++ Name,
            case file:read_file(Dir ++ "/environ") of
                {ok, Env} ->
                    Tags = [Thread || <<"YACWU_THREAD_ID=", Thread/binary>> <- binary:split(Env, <<0>>, [global]), Thread =/= <<>>],
                    case Tags of
                        [Thread | _] ->
                            try info(Pid, Dir, Uptime) of
                                {true, Info} -> {Thread, Info};
                                false -> false
                            catch _:_ -> false end;
                        _ -> false
                    end;
                _ -> false
            end;
        _ -> false
    end.

info(Pid, Dir, Uptime) ->
    case file:read_file(Dir ++ "/stat") of
        {ok, Stat} ->
            %% "pid (comm) state ppid ...": fields after the last ')'.
            [_, Rest] = string:split(Stat, <<")">>, trailing),
            Fields = string:lexemes(Rest, " "),
            Int = fun(N) -> binary_to_integer(lists:nth(N, Fields)) end,
            Ppid = Int(2),
            Cpu = Int(12) + Int(13),
            %% Clock ticks; Linux reports 100 a second.
            Elapsed = max(0, Uptime - Int(20) div 100),
            Command = case file:read_file(Dir ++ "/cmdline") of
                {ok, Bytes} -> string:trim(binary:replace(Bytes, <<0>>, <<" ">>, [global]));
                _ -> <<>>
            end,
            {true, {Pid, Ppid, truncate(Command), Elapsed, Cpu}};
        _ -> false
    end.

truncate(Command) when byte_size(Command) > 300 -> binary:part(Command, 0, 300);
truncate(Command) -> Command.

uptime() ->
    case file:read_file("/proc/uptime") of
        {ok, Text} ->
            [Seconds | _] = string:lexemes(Text, " ."),
            binary_to_integer(Seconds);
        _ -> 0
    end.

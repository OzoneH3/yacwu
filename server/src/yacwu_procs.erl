-module(yacwu_procs).
-export([tagged/1]).

%% Processes on this machine whose environment carries
%% YACWU_THREAD_ID=Thread (the Claude wrapper tags each session's Claude
%% process; the commands it starts inherit the tag), as
%% {Pid, ParentPid, Command, ElapsedSeconds, CpuCentiseconds}.
%% Linux /proc only; anything unreadable is skipped.
tagged(Thread) ->
    Tag = <<0, "YACWU_THREAD_ID=", Thread/binary, 0>>,
    Uptime = uptime(),
    case file:list_dir("/proc") of
        {ok, Names} ->
            lists:filtermap(fun(Name) -> process(Name, Tag, Uptime) end, Names);
        _ -> []
    end.

process(Name, Tag, Uptime) ->
    case string:to_integer(Name) of
        {Pid, []} ->
            Dir = "/proc/" ++ Name,
            case file:read_file(Dir ++ "/environ") of
                {ok, Env} ->
                    case binary:match(<<0, Env/binary>>, Tag) of
                        nomatch -> false;
                        _ -> info(Pid, Dir, Uptime)
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

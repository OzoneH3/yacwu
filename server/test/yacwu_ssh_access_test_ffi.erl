-module(yacwu_ssh_access_test_ffi).
-export([forwarder_expires/1]).

%% Exercise the actual watchdog against our own fake ssh process. No network
%% connections, user keys, or app-server processes are involved.
forwarder_expires(Wrapper) ->
    Root = filename:join(os:getenv("TMPDIR", "/tmp"), "yacwu-expiry-" ++ integer_to_list(erlang:unique_integer([positive]))),
    Bin = filename:join(Root, "bin"),
    ok = filelib:ensure_dir(filename:join(Bin, "unused")),
    PidFile = filename:join(Root, "ssh.pid"),
    Fake = filename:join(Bin, "ssh"),
    ok = file:write_file(Fake, <<"#!/bin/sh\nprintf '%s' \"$$\" > \"$YACWU_TEST_PID\"\nexec sleep 30\n">>),
    ok = file:change_mode(Fake, 8#700),
    Port = open_port({spawn_executable, os:find_executable("sh")},
        [binary, exit_status, use_stdio, stderr_to_stdout,
         {args, ["-c", binary_to_list(Wrapper), "sh"]},
         {env, [{"PATH", Bin ++ ":" ++ os:getenv("PATH")}, {"YACWU_TEST_PID", PidFile}]}]),
    try
        Deadline = erlang:monotonic_time(millisecond) + 4000,
        case wait_pid(PidFile, Deadline) of
            {ok, Pid} -> wait_dead(Pid, Deadline);
            _ -> false
        end
    after
        catch port_close(Port),
        %% If the assertion failed, the watchdog cleanup still owns this
        %% test child and kills it when stdin closes.
        file:del_dir_r(Root)
    end.

wait_pid(Path, Deadline) ->
    case file:read_file(Path) of
        {ok, Pid} when byte_size(Pid) > 0 -> {ok, binary_to_list(Pid)};
        _ -> case erlang:monotonic_time(millisecond) < Deadline of
            true -> timer:sleep(10), wait_pid(Path, Deadline);
            false -> error
        end
    end.
wait_dead(Pid, Deadline) ->
    case file:read_file("/proc/" ++ Pid ++ "/stat") of
        {error, enoent} -> true;
        {ok, Data} ->
            case binary:match(Data, <<") Z ">>) of
                {_, _} -> true;
                nomatch -> case erlang:monotonic_time(millisecond) < Deadline of
                    true -> timer:sleep(20), wait_dead(Pid, Deadline);
                    false -> false
                end
            end;
        _ -> false
    end.

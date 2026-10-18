-module(yacwu_procs_test_ffi).
-export([start_tagged_sleep/1, stop/1, shared_snapshot/0, wait_for_snapshot/0]).

%% A short-lived `sleep` carrying YACWU_THREAD_ID=Thread, as a tagged
%% session's command would.
start_tagged_sleep(Thread) ->
    Sleep = os:find_executable("sleep"),
    open_port({spawn_executable, Sleep}, [{args, ["30"]}, {env, [{"YACWU_THREAD_ID", binary_to_list(Thread)}]}]).

stop(Port) ->
    {os_pid, Pid} = erlang:port_info(Port, os_pid),
    os:cmd("kill " ++ integer_to_list(Pid)),
    catch port_close(Port),
    nil.

shared_snapshot() ->
    Thread = list_to_binary("snapshot-" ++ integer_to_list(erlang:unique_integer([positive]))),
    timer:sleep(1100),
    _ = yacwu_procs:tagged(Thread),
    Port = start_tagged_sleep(Thread),
    try
        timer:sleep(50),
        Cached = yacwu_procs:tagged(Thread),
        timer:sleep(1100),
        Fresh = yacwu_procs:tagged(Thread),
        Cached =:= [] andalso Fresh =/= []
    after stop(Port) end.

wait_for_snapshot() -> timer:sleep(1100), nil.

-module(yacwu_build_watch_test_ffi).
-export([exercise/0]).
exercise() ->
    Path = filename:join(os:getenv("TMPDIR", "../.workspace"), "build-watch-test-" ++ integer_to_list(erlang:unique_integer([positive]))),
    ok = filelib:ensure_dir(Path),
    Owner = spawn(fun() -> receive stop -> ok end end),
    Parent = self(), Notify = fun(Message) -> Parent ! {build_notice, Message}, nil end,
    try
        ok = file:write_file(Path, <<"first">>),
        yacwu_build_watch:subscribe(Owner, Path, Notify),
        Watcher = whereis(yacwu_build_watch),
        yacwu_build_watch:subscribe(Owner, Path, Notify),
        Watcher = whereis(yacwu_build_watch),
        ok = file:write_file(Path, <<"second">>),
        Watcher ! tick,
        receive {build_notice, <<"{\"method\":\"yacwu/buildUpdated\",\"params\":{}}">>} -> ok after 1000 -> error(no_update) end,
        receive {build_notice, _} -> error(duplicate_update) after 20 -> ok end,
        ok = file:delete(Path), Watcher ! tick,
        receive {build_notice, _} -> error(missing_file_update) after 20 -> ok end,
        ok = file:write_file(Path, <<"second">>), Watcher ! tick,
        receive {build_notice, _} -> error(unchanged_update) after 20 -> ok end,
        Ref = erlang:monitor(process, Watcher), Owner ! stop,
        receive {'DOWN', Ref, process, Watcher, _} -> ok after 1000 -> error(watcher_leaked) end,
        true
    after Owner ! stop, file:delete(Path) end.

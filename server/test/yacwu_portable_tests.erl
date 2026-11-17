-module(yacwu_portable_tests).
-export([run/0]).
run() ->
    Modules = [platform_test, files_test, git_test, file_access_test,
               relay_core_test, relay_routes_test, relay_settings_test],
    Result = eunit:test(Modules, [verbose, {scale_timeouts, 10}]),
    erlang:halt(case Result of ok -> 0; _ -> 1 end).

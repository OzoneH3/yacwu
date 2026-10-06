-module(yacwu_benchmark).
-export([launch/2, update/2, finish/2, status/1, cancel/1, cancelled/1, check_due/0]).

check_due() ->
    Now = erlang:monotonic_time(millisecond),
    case get(yacwu_benchmark_checked_at) of
        Last when is_integer(Last), Now - Last < 2000 -> false;
        _ -> put(yacwu_benchmark_checked_at, Now), true
    end.

call(Message) ->
    case whereis(yacwu_benchmark_state) of
        undefined ->
            Pid = spawn(fun() -> loop(#{}) end),
            try register(yacwu_benchmark_state, Pid) catch error:badarg -> exit(Pid, kill) end;
        _ -> ok
    end,
    Ref = make_ref(),
    yacwu_benchmark_state ! {self(), Ref, Message},
    receive {Ref, Reply} -> Reply after 2000 -> error(benchmark_state_timeout) end.

launch(Label, Fun) -> call({launch, Label, Fun}).
update(Label, Json) -> call({update, Label, Json, true}).
finish(Label, Json) -> call({update, Label, Json, false}).
status(Label) -> call({status, Label}).
cancel(Label) -> call({cancel, Label}).
cancelled(Label) -> call({cancelled, Label}).

loop(State) ->
    receive
        {From, Ref, {launch, Label, Fun}} ->
            case maps:get(Label, State, {<<"{\"status\":\"idle\"}">>, false, false}) of
                {_, _, true} -> From ! {Ref, false}, loop(State);
                _ ->
                    {Pid, Monitor} = spawn_monitor(fun() -> Fun() end),
                    From ! {Ref, true},
                    loop(State#{Label => {<<"{\"status\":\"starting\"}">>, false, true}, {monitor, Monitor} => {Label, Pid}})
            end;
        {From, Ref, {update, Label, Json, Running}} ->
            {_, Cancelled, _} = maps:get(Label, State, {<<>>, false, false}),
            From ! {Ref, nil}, loop(State#{Label => {Json, Cancelled, Running}});
        {From, Ref, {status, Label}} ->
            {Json, _, _} = maps:get(Label, State, {<<"{\"status\":\"idle\"}">>, false, false}),
            From ! {Ref, Json}, loop(State);
        {From, Ref, {cancel, Label}} ->
            {Json, _, Running} = maps:get(Label, State, {<<"{\"status\":\"idle\"}">>, false, false}),
            From ! {Ref, nil}, loop(State#{Label => {Json, true, Running}});
        {From, Ref, {cancelled, Label}} ->
            {_, Cancelled, _} = maps:get(Label, State, {<<>>, false, false}),
            From ! {Ref, Cancelled}, loop(State);
        {'DOWN', Monitor, process, _, _} ->
            case maps:take({monitor, Monitor}, State) of
                {{Label, _}, Rest} ->
                    {Json, Cancelled, Running} = maps:get(Label, Rest),
                    Final = case Running of true -> <<"{\"status\":\"failed\",\"message\":\"Benchmark worker ended unexpectedly\"}">>; false -> Json end,
                    loop(Rest#{Label => {Final, Cancelled, false}});
                error -> loop(State)
            end
    end.

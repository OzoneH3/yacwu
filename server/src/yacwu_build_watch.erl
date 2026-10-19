-module(yacwu_build_watch).
-export([subscribe/3]).

%% One timer and file read per static root, regardless of browser tab count.
subscribe(Owner, Path, Notify) ->
    Pid = owner(), Ref = erlang:monitor(process, Pid),
    Pid ! {subscribe, self(), Ref, Owner, Path, Notify},
    receive
        {Ref, ready} -> erlang:demonitor(Ref, [flush]), nil;
        {'DOWN', Ref, process, Pid, _} -> subscribe(Owner, Path, Notify)
    after 5000 -> erlang:demonitor(Ref, [flush]), nil
    end.

owner() ->
    case whereis(yacwu_build_watch) of
        undefined ->
            Pid = spawn(fun() -> receive start -> erlang:send_after(2000, self(), tick), loop(#{}, #{}) end end),
            try register(yacwu_build_watch, Pid) of
                true -> Pid ! start, Pid
            catch error:badarg -> exit(Pid, kill), owner() end;
        Pid -> Pid
    end.

version(Path) -> case file:read_file(Path) of {ok, Data} -> Data; _ -> <<>> end.

loop(Subscribers, Versions) ->
    receive
        {subscribe, From, Ref, Owner, Path, Notify} ->
            Monitor = case maps:find(Owner, Subscribers) of
                {ok, {M, _, _}} -> M;
                error -> erlang:monitor(process, Owner)
            end,
            Next = case maps:is_key(Path, Versions) of true -> Versions; false -> Versions#{Path => version(Path)} end,
            From ! {Ref, ready},
            loop(Subscribers#{Owner => {Monitor, Path, Notify}}, Next);
        {'DOWN', _, process, Owner, _} ->
            Remaining = maps:remove(Owner, Subscribers),
            case map_size(Remaining) of
                0 -> ok;
                _ -> loop(Remaining, Versions)
            end;
        tick ->
            Paths = lists:usort([Path || {_, Path, _} <- maps:values(Subscribers)]),
            Next = lists:foldl(fun(Path, Acc) ->
                Current = version(Path), Previous = maps:get(Path, Versions, <<>>),
                case Current =/= <<>> andalso Current =/= Previous of
                    true -> maps:foreach(fun(_, {_, P, Notify}) ->
                        case P =:= Path of
                            true -> Notify(<<"{\"method\":\"yacwu/buildUpdated\",\"params\":{}}">>);
                            false -> ok
                        end
                    end, Subscribers);
                    false -> ok
                end,
                Acc#{Path => case Current of <<>> -> Previous; _ -> Current end}
            end, #{}, Paths),
            erlang:send_after(2000, self(), tick),
            loop(Subscribers, Next)
    end.

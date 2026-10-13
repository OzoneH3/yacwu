-module(yacwu_time).
-export([rfc3339_seconds/1]).

%% Unix seconds of an RFC 3339 time ("2026-10-13T05:06:06Z"), or error.
rfc3339_seconds(Text) ->
    try {ok, calendar:rfc3339_to_system_time(binary_to_list(Text))}
    catch _:_ -> {error, nil}
    end.

-module(yacwu_usage).
-export([path/1, append/2, read/1, read_all/0, fingerprint/1, now/0, read_delta/1]).
-include_lib("kernel/include/file.hrl").

now() -> erlang:system_time(millisecond).

fingerprint(Value) -> binary:encode_hex(crypto:hash(sha256, Value)).

path(Label) ->
    State = os:getenv("XDG_STATE_HOME", filename:join(os:getenv("HOME", "/tmp"), ".local/state")),
    Dir = os:getenv("YACWU_USAGE_DIR", filename:join(State, "yacwu/usage")),
    unicode:characters_to_binary(filename:join(Dir, "usage-" ++ integer_to_list(erlang:phash2(Label)) ++ ".jsonl")).

%% Each host's manager serializes writes. Telemetry must never interrupt work.
append(Label, Line) ->
    try
        Path = path(Label),
        ok = filelib:ensure_dir(Path),
        ok = file:change_mode(filename:dirname(Path), 8#700),
        case file:read_file_info(Path) of
            {ok, #file_info{size = Size}} when Size >= 20971520 ->
                Previous = <<Path/binary, ".1">>,
                _ = file:delete(Previous),
                ok = file:rename(Path, Previous);
            _ -> ok
        end,
        ok = file:write_file(Path, [Line, "\n"], [append]),
        ok = file:change_mode(Path, 8#600),
        true
    catch _:_ -> false end.

read(Label) ->
    Path = path(Label),
    Read = fun(P) -> case file:read_file(P) of {ok, Bytes} -> Bytes; _ -> <<>> end end,
    <<(Read(<<Path/binary, ".1">>))/binary, (Read(Path))/binary>>.

read_all() ->
    Dir = filename:dirname(path(<<"local">>)),
    case file:list_dir(Dir) of
        {ok, Names} ->
            Read = fun(P) -> case file:read_file(P) of {ok, Bytes} -> <<Bytes/binary, "\n">>; _ -> <<>> end end,
            Parts = [[Read(filename:join(Dir, unicode:characters_to_binary([Name, ".1"]))), Read(filename:join(Dir, Name))]
                     || Name <- lists:sort(Names), re:run(Name, "^usage-[0-9]+\\.jsonl$", [{capture, none}]) =:= match],
            iolist_to_binary(Parts);
        _ -> <<>>
    end.

%% A cursor records only the journal names/inodes and consumed byte offsets.
%% Rotation, truncation, additions and deletions reset the snapshot. Never use
%% client-provided names to open files; derive every path from our state dir.
read_delta(Cursor) ->
    Dir = filename:dirname(path(<<"local">>)),
    Names = case file:list_dir(Dir) of
        {ok, Entries} -> lists:sort([unicode:characters_to_binary(N) || N <- Entries,
            re:run(N, "^usage-[0-9]+\\.jsonl(\\.1)?$", [{capture, none}]) =:= match]);
        _ -> []
    end,
    Ordered = lists:sort(fun(A, B) -> journal_order(A) =< journal_order(B) end, Names),
    Current = lists:filtermap(fun(Name) ->
        case file:read_file_info(filename:join(Dir, Name)) of
            {ok, #file_info{inode = Inode, size = Size}} -> {true, {Name, Inode, Size}};
            _ -> false
        end
    end, Ordered),
    Old = decode_cursor(Cursor),
    Valid = valid_cursor(Old, Current),
    Parts = [delta_part(Dir, Entry, case Valid of true -> element(3, lists:keyfind(element(1, Entry), 1, Old)); false -> 0 end)
             || Entry <- Current],
    Manifest = [Entry || {_, Entry} <- Parts],
    Bytes = iolist_to_binary([Data || {Data, _} <- Parts]),
    {Bytes, base64:encode(term_to_binary(Manifest)), not Valid}.

decode_cursor(Cursor) when byte_size(Cursor) > 0, byte_size(Cursor) < 16384 ->
    try
        case base64:decode(Cursor) of
            <<131, 80, _/binary>> -> invalid; % Never expand compressed client terms.
            Binary -> binary_to_term(Binary, [safe])
        end
    catch _:_ -> invalid end;
decode_cursor(_) -> invalid.

valid_cursor(Old, Current) when is_list(Old), length(Old) =:= length(Current) ->
    lists:all(fun({Name, Inode, Size}) ->
        case lists:keyfind(Name, 1, Old) of
            {Name, Inode, Offset} when is_integer(Offset), Offset >= 0, Offset =< Size -> true;
            _ -> false
        end
    end, Current);
valid_cursor(_, _) -> false.

delta_part(Dir, {Name, Inode, Size}, Offset) ->
    Data = case file:open(filename:join(Dir, Name), [read, binary, raw]) of
        {ok, Fd} ->
            try
                %% Fail rather than advance past data if rotation raced this read.
                {ok, #file_info{inode = Inode}} = file:read_file_info(Fd),
                case Size - Offset of
                    0 -> <<>>;
                    Count -> case file:pread(Fd, Offset, Count) of
                        {ok, Value} -> Value;
                        eof -> <<>>;
                        {error, Reason} -> error(Reason)
                    end
                end
            after file:close(Fd) end;
        {error, Reason} -> error(Reason)
    end,
    %% A writer may be between writing a JSON record and its final newline.
    Complete = case binary:matches(Data, <<"\n">>) of
        [] -> <<>>;
        Matches -> {Position, 1} = lists:last(Matches), binary:part(Data, 0, Position + 1)
    end,
    {Complete, {Name, Inode, Offset + byte_size(Complete)}}.

%% Match read_all/0 ordering: previous generation precedes the current journal.
journal_order(Name) ->
    case filename:extension(Name) of
        <<".1">> -> {filename:rootname(Name), 0};
        _ -> {Name, 1}
    end.

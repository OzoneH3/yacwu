-module(yacwu_platform).
-export([is_windows/0, home/0, state_home/0, temp_dir/0, normalize/1,
         is_absolute/1, windows_absolute/1, resolve/2, restrict/2, mode/2,
         spawn_codex/3, valid_path/1, windows_relative/1]).

is_windows() -> element(1, os:type()) =:= win32.
text(Value) -> unicode:characters_to_binary(Value).
chars(Value) -> unicode:characters_to_list(Value).
first([], Default) -> Default;
first([Name | Rest], Default) ->
    case os:getenv(Name) of false -> first(Rest, Default); "" -> first(Rest, Default); V -> text(V) end.
home() ->
    case is_windows() of
        true -> normalize(first(["USERPROFILE", "HOME"], text(filename:absname("."))));
        false -> first(["HOME"], <<"/">>)
    end.
state_home() ->
    Default = case is_windows() of
        true -> first(["LOCALAPPDATA"], filename:join(home(), <<"AppData/Local">>));
        false -> filename:join(home(), <<".local/state">>)
    end,
    normalize(first(["XDG_STATE_HOME"], Default)).
temp_dir() ->
    Default = case is_windows() of true -> filename:join(state_home(), <<"Temp">>); false -> <<"/tmp">> end,
    normalize(first(["TMPDIR", "TEMP", "TMP"], Default)).
normalize(Path) ->
    case is_windows() of true -> binary:replace(Path, <<"\\">>, <<"/">>, [global]); false -> Path end.
windows_absolute(Path) ->
    P = binary:replace(Path, <<"\\">>, <<"/">>, [global]),
    binary:match(P, <<0>>) =:= nomatch andalso
    case re:run(P, <<"^(?:[A-Za-z]:/|//[^/? .][^/]*/[^/.][^/]*(?:/|$))">>, [{capture, none}]) of
        match -> true;
        nomatch -> false
    end.
is_absolute(Path) ->
    binary:match(Path, <<0>>) =:= nomatch andalso
    case is_windows() of
        true -> windows_absolute(Path);
        false -> filename:pathtype(Path) =:= absolute
    end.
windows_relative(Path) ->
    lists:all(fun
        (<<>>) -> true;
        (<<".">>) -> true;
        (<<"..">>) -> true;
        (Part) ->
            re:run(Part, <<"[<>:\\x00-\\x1f|?*\\\\]|[ .]$|^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)">>,
                   [caseless, {capture, none}]) =:= nomatch
    end, binary:split(Path, <<"/">>, [global])).
valid_path(Path) ->
    P = normalize(Path),
    binary:match(P, <<0>>) =:= nomatch andalso
    case is_windows() of
        false -> true;
        true ->
            case P of
                <<"//?/", _/binary>> -> false;
                <<"//./", _/binary>> -> false;
                <<Drive, ":/", Rest/binary>> when Drive >= $a, Drive =< $z; Drive >= $A, Drive =< $Z ->
                    binary:match(Rest, <<":">>) =:= nomatch;
                _ -> binary:match(P, <<":">>) =:= nomatch
            end
    end.
resolve(Path, Base) -> normalize(text(filename:absname(chars(Path), filename:absname(chars(Base))))).

%% Windows permissions are ACLs. Ordinary state files inherit the user's
%% directory ACL; relay credentials explicitly restrict the containing directory.
mode(Path, Mode) -> case is_windows() of true -> ok; false -> file:change_mode(Path, Mode) end.
restrict(Path, Directory) ->
    case is_windows() of
        false ->
            case file:change_mode(Path, case Directory of true -> 8#700; false -> 8#600 end) of
                ok -> {ok, nil}; {error, Why} -> {error, text(file:format_error(Why))}
            end;
        true ->
            Script = filename:join(root(), "scripts/protect-path.ps1"),
            case os:find_executable("powershell.exe") of
                false -> {error, <<"Windows PowerShell is required to protect relay credentials">>};
                Ps ->
                    Port = open_port({spawn_executable, Ps}, [binary, exit_status, use_stdio, hide,
                        stderr_to_stdout, {args, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                        "-File", Script, "-LiteralPath", chars(Path)]}]),
                    protected(Port)
            end
    end.
protected(Port) ->
    receive
        {Port, {data, _}} -> protected(Port);
        {Port, {exit_status, 0}} -> {ok, nil};
        {Port, {exit_status, _}} -> {error, <<"Could not restrict the relay credential ACL">>}
    after 15000 -> try port_close(Port) catch _:_ -> ok end, {error, <<"Relay ACL setup timed out">>}
    end.
root() -> chars(first(["YACWU_BACKEND_ROOT"], text(filename:absname("..")))).

%% A Node bridge resolves npm's Windows Codex shim without a command shell,
%% separates diagnostic stderr from JSON-RPC stdout, and reaps the child tree
%% when the BEAM port closes (including an unexpected BEAM exit).
spawn_codex(Command, Cwd, Stderr) ->
    Node = case os:find_executable("node") of false -> error(node_not_found); Found -> Found end,
    Bridge = filename:join(root(), "scripts/codex-stdio.mjs"),
    open_port({spawn_executable, Node}, [binary, exit_status, use_stdio, hide,
        {cd, chars(Cwd)}, {args, [Bridge | [chars(A) || A <- Command]]},
        {env, [{"YACWU_CODEX_STDERR_LOG", chars(Stderr)},
               {"RUST_LOG", os:getenv("RUST_LOG", "info")}, {"LD_LIBRARY_PATH", false}]}]).

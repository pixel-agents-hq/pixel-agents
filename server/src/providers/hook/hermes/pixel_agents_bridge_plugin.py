"""pixel_agents_bridge — forwards Hermes plugin-hook activity to Pixel Agents.

Installed by codexProvider's sibling, hermesProvider.installHooks(), by copying this
file (unmodified) to ~/.hermes/hermes-agent/plugins/pixel_agents_bridge/__init__.py
alongside a generated plugin.yaml. Hermes discovers it via HookRegistry.discover_and_load()
on its next process start -- per Hermes's plugin-hook docs, plugin hooks fire in both
CLI and gateway sessions, but only for sessions started *after* the plugin is loaded.
A session already running when this file is installed will not see it until restarted.

Mirrors claude-hook.ts's multi-server registry fan-out: reads every live server
record from ~/.pixel-agents/servers/*.json (skipping dead PIDs) and POSTs to all of
them, since a plugin hook fires in a separate OS process from any pixel-agents
server instance, unlike Codex's in-process tailer.

Failure mode: silent and best-effort throughout, exactly like every other Hermes
hook handler -- a dead or unreachable pixel-agents server must never affect the
Hermes session it's instrumenting. urllib only (stdlib), so no extra dependency
enters Hermes's venv for a purely-optional integration.
"""

from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path
from typing import Any, Dict

_HOOK_API_PATH = "/api/hooks/hermes"
_TIMEOUT_S = 2.0


def _registry_dir() -> Path:
    return Path.home() / ".pixel-agents" / "servers"


def _is_pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but is owned by someone else -- still alive.
        return True
    except Exception:
        return False
    return True


def _live_servers() -> list[Dict[str, Any]]:
    directory = _registry_dir()
    servers: list[Dict[str, Any]] = []
    try:
        entries = list(directory.glob("*.json"))
    except Exception:
        return servers
    for entry in entries:
        try:
            data = json.loads(entry.read_text(encoding="utf-8"))
        except Exception:
            continue
        pid = data.get("pid")
        port = data.get("port")
        token = data.get("token")
        if not isinstance(pid, int) or not isinstance(port, int) or not isinstance(token, str):
            continue
        if not _is_pid_alive(pid):
            continue
        servers.append(data)
    return servers


def _post(server: Dict[str, Any], body: bytes) -> None:
    url = f"http://127.0.0.1:{server['port']}{_HOOK_API_PATH}"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {server['token']}",
        },
    )
    try:
        urllib.request.urlopen(req, timeout=_TIMEOUT_S).close()
    except Exception:
        pass  # best-effort; never let a dropped delivery affect the Hermes session


def _emit(hook_event_name: str, session_id: str, **fields: Any) -> None:
    if not session_id:
        return
    servers = _live_servers()
    if not servers:
        return
    body = json.dumps({"hook_event_name": hook_event_name, "session_id": session_id, **fields}).encode(
        "utf-8"
    )
    for server in servers:
        _post(server, body)


# ── Plugin hook handlers ──
#
# Signatures match the documented payload fields for each hook (see
# ~/.hermes/hermes-agent/website/docs/user-guide/features/hooks.md, "Shipped
# plugin-hook catalog"). All accept **_ for forward compatibility per Hermes's
# "General rules for all hooks".


def _on_session_start(session_id: str = "", model: str = "", platform: str = "", **_: Any) -> None:
    _emit("SessionStart", session_id, cwd=os.getcwd())


def _on_pre_tool_call(
    tool_name: str = "",
    args: Any = None,
    tool_call_id: str = "",
    session_id: str = "",
    **_: Any,
) -> None:
    _emit(
        "ExecStart",
        session_id,
        tool_id=tool_call_id or f"hermes-{tool_name}",
        tool_name=tool_name,
        tool_input=args,
    )


def _on_post_tool_call(tool_call_id: str = "", session_id: str = "", **_: Any) -> None:
    _emit("ExecEnd", session_id, tool_id=tool_call_id or "current")


def _on_session_end(
    session_id: str = "",
    completed: bool = True,
    interrupted: bool = False,
    **_: Any,
) -> None:
    # Hermes fires on_session_end at each TURN's finalization, not just process
    # exit -- this is the per-turn "done / waiting for input" signal, normalized
    # as turnEnd. Real process teardown is on_session_finalize (below).
    _emit("TurnEnd", session_id, awaiting_input=bool(interrupted))


def _on_session_finalize(session_id: str = "", reason: str = "", **_: Any) -> None:
    _emit("SessionEnd", session_id, reason=reason or "finalize")


def _on_subagent_start(
    child_session_id: str = "",
    parent_session_id: str = "",
    child_role: str = "",
    child_goal: str = "",
    **_: Any,
) -> None:
    _emit(
        "SubagentStart",
        parent_session_id,
        child_session_id=child_session_id,
        agent_type=child_role or "subagent",
        goal=child_goal,
    )


def _on_subagent_stop(parent_session_id: str = "", child_session_id: str = "", **_: Any) -> None:
    _emit("SubagentStop", parent_session_id, child_session_id=child_session_id)


def register(ctx: Any) -> None:
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("on_session_finalize", _on_session_finalize)
    ctx.register_hook("subagent_start", _on_subagent_start)
    ctx.register_hook("subagent_stop", _on_subagent_stop)

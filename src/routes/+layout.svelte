<script lang="ts">
	import '@fontsource-variable/newsreader';
	import '@fontsource-variable/newsreader/wght-italic.css';
	import '@fontsource-variable/inter';
	import '@fontsource-variable/jetbrains-mono';
	import { onMount, tick, untrack } from 'svelte';
	import McpToolActivity from '$lib/McpToolActivity.svelte';
	import { mcpActivityLabel } from '$lib/mcp-activity';
	import { compactActivity, compactActivityLabel } from '$lib/compact-activity';
	import { removePendingTodo } from '$lib/todo-queue';
	import { clearsStalledWorkerPrompt } from '$lib/stalled-worker';
	import { filterArchives, type ArchiveFilter } from '$lib/archive';
	import SessionRulesEditor from '$lib/SessionRulesEditor.svelte';
	import GlobalSettingsForm from '$lib/GlobalSettingsForm.svelte';
	import { defaultSettings, GLOBAL_SETTINGS_KEY, readSettings, sendsMessage, type GlobalSettings } from '$lib/settings';
	import {
		applyRelayEvent,
		applyRelaySnapshot,
		attributeRelayPart,
		emptyRelayStore,
		relayStatusLabel,
		shortSession,
		type AttributedFrame,
		type RelayRecord
	} from '$lib/relay';
	import { defaultSessionRules, readSessionRules, withSessionRules, SESSION_RULES_KEY, type SessionRules } from '$lib/session-rules';
	import { settleTranscriptBottom } from '$lib/transcript-scroll';
	import { runtimeOutcome, interruptionReason } from '$lib/runtime-reconciliation';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import {
		currentContextTokens,
		reportedTokenStatistics,
		type TokenStatistics,
		hostQuery,
		isRemoteHost,
		LOCAL_HOST,
		type HostInfo,
		type JsonRpcNotification,
		type ThreadItem,
		type ThreadSummary,
		type Turn
	} from '$lib/protocol';
	import {
		agentLabel,
		agentRootId,
		agentsForSession,
		isSubAgentThread,
		isAgentRunning,
		mergeAgentThreadMeta,
		trackAgentItem,
		unannouncedSpawn,
		visibleAgentMessageText,
		type AgentInfo,
		type AgentRegistry
	} from '$lib/agents';
	import { parseSlash, SLASH_HELP, filterSlashCommands, type SlashCommandInfo } from '$lib/slash';
	import { ComposerHistory } from '$lib/history';
	import FileBrowser from '$lib/FileBrowser.svelte';
	import GitDiffViewer from '$lib/GitDiffViewer.svelte';
	import UsageHistory from '$lib/UsageHistory.svelte';
	import ModelSuggestion from '$lib/ModelSuggestion.svelte';
	import { analyzeUsage } from '$lib/usage-analysis';
	import { summarizeTaskAllowances, projectTaskUsage, formatAllowancePercent, type TaskUsageSummary } from '$lib/task-usage';
	import { replaceSessionWithEmptyThread } from '$lib/session-clear';
	import { readWorkspaceLink } from '$lib/workspace-links';
	import { markdownFileReferences, parseCodexMarkdown, type MarkdownBlock, type MarkdownInline } from '$lib/markdown';
import { detectPromptKind, pendingQuestionsForThread } from '$lib/interactive-choice';
	import { hasSharedChannelContext, sharedChannelPath, visibleUserText, withSharedChannelContext } from '$lib/shared-channel';
import { estimateRemainingMinutes, parseTaskProgress, separateTaskProgressEntries, stripTaskProgressMarkers, withTaskProgressInstructions } from '$lib/task-progress';
import { indexFileLineStats, lineStatsForPath, normalizeWorkspacePath } from '$lib/file-change-stats';
import { archiveProviderLabel, archiveDeletionSupported, loadArchiveCatalog } from '$lib/archive';
import { claudeBackendHost, sessionTarget } from '$lib/session-target';
import { filterAndSortModelChoices, modelDisplayProfile, isClaudeModelCatalog, claudeModelIdentity } from '$lib/model-display';

	let { children } = $props();

	interface Goal {
		objective: string;
		status: string;
		tokenBudget: number | null;
		tokensUsed: number;
		timeUsedSeconds: number;
	}

	interface ThreadState {
		tokenStatistics?: TokenStatistics;
		order: string[];
		byId: Record<string, ThreadItem>;
		status: 'idle' | 'running';
		turnId: string | null;
		tokens: number | null;
		contextWindow: number | null;
		error: string | null;
		goal: Goal | null;
		turnStartedAt: number | null;
	}

	interface SelectedAttachment {
		id: string;
		file: File;
		name: string;
		kind: 'image' | 'file';
		previewUrl: string | null;
	}

	interface ArchivedSessionSnapshot {
		id: string;
		label: string;
		index: number;
		summary: ThreadSummary;
		thread: ThreadState | undefined;
		config: { model: string; effort: string; profile: string | null } | undefined;
		cwd: string | undefined;
	}

	interface ArchiveNotice {
		tone: 'undo' | 'info' | 'error';
		message: string;
		snapshot?: ArchivedSessionSnapshot;
	}

	interface ModelChoice {
		id: string;
		displayName: string;
		defaultEffort: string;
		efforts: string[];
	}

	interface TodoQueue {
		tasks: string[];
		startedCount: number;
		currentTask: string | null;
		initialTask: string | null;
	}

	interface ModelState {
		model: string;
		effort: string;
		models: ModelChoice[];
	}

	interface RateLimitWindow {
		usedPercent: number;
		windowDurationMins: number;
		resetsAt: number;
	}

	interface AccountUsage {
		fiveHour: RateLimitWindow | null;
	sevenDay: RateLimitWindow | null;
	}

	interface ProfileChoice {
		name: string;
		model: string | null;
	}

	interface DirectoryChoice {
		name: string;
		kind: 'dir' | 'file' | 'other';
		symlink: boolean;
	}

	type RenderPart =
		| { type: 'text'; text: string }
		| { type: 'image'; path: string; source: 'local' | 'remote' }
		| { type: 'relay'; frames: AttributedFrame[] };

	let localCounter = 0;

	// Optimistic user messages awaiting the backend's own userMessage item.
	// Codex echoes one per turn (we then drop ours); claude-codex-style
	// backends never do, so the optimistic copy is what the user sees.
	const pendingUserEchoes: Record<string, { id: string; text: string }[]> = {};

	let sessions = $state<ThreadSummary[]>([]);
	const SESSION_ORDER_KEY = 'yacwu-session-order';
	const EMPTY_SESSION_HOSTS_KEY = 'yacwu-empty-session-hosts';
	const WORKSPACE_SPLIT_KEY = 'yacwu-workspace-split';
	const DISMISSED_GOALS_KEY = 'yacwu-dismissed-goals';
	let sessionOrder = $state<string[]>([]);
	let workspaceSplitRatio = $state(0.38);
	let workspaceSplitEl = $state<HTMLDivElement | null>(null);
	let workspaceResizePointerId = $state<number | null>(null);
	let dismissedGoalBySession = $state<Record<string, string>>({});
	let draggingSessionId = $state<string | null>(null);
	let dragOverSessionId = $state<string | null>(null);
	let suppressSessionClickId: string | null = null;
	let pointerSessionDrag = $state<{
		id: string;
		pointerId: number;
		startX: number;
		startY: number;
		targetId: string | null;
		active: boolean;
	} | null>(null);
	// Host picker: local plus the remote machines found in ~/.ssh/config.
	let newMachine = $state(LOCAL_HOST);
	let newProvider = $state<'codex' | 'claude'>('codex');
	let hostChoices = $state<HostInfo[]>([]);
	const claudeHost = $derived(claudeBackendHost(hostChoices));
	const machineChoices = $derived(hostChoices.filter((host) => host.kind !== 'backend'));
	const newHost = $derived(sessionTarget(newMachine, newProvider, claudeHost));
	// Live connection state per remote host, fed by yacwu/host/status events.
	let hostStates = $state<Record<string, string>>({});
	let hostDefaultCwds = $state<Record<string, string>>({});
	let sessionsLoaded = $state(false);
	let threads = $state<Record<string, ThreadState>>({});
	let sessionHistoryLoaded = $state<Record<string, boolean>>({});
	let sessionOpening = $state<Record<string, boolean>>({});
	let interruptedSessions = $state<Record<string, boolean>>({});
	let finishedSessions = $state<Record<string, boolean>>({});
	let dismissedAttentionByThread = $state<Record<string, boolean>>({});
	let recoveringSessions = $state<Record<string, boolean>>({});
	let startupRecoveryComplete = $state(false);
	let sessionConfigs = $state<Record<string, { model: string; effort: string; profile: string | null }>>({});
	let fastSessions = $state<Record<string, boolean>>({});
	let input = $state('');
	let promptDrafts = $state<Record<string, string>>({});
	let promptDraftSessionId = $state<string | null>(null);
	let selectedAttachments = $state<SelectedAttachment[]>([]);
	let sendingMessage = $state(false);
	let connected = $state(false);
	let cwds = $state<Record<string, string>>({});
	let conflict = $state<{ id: string; holders: { pid: number; command: string }[] } | null>(null);
	let mobileSidebarOpen = $state(false);
	let mobileViewport = $state(false);
	let desktopSidebarHidden = $state(false);
	let theme = $state<'light' | 'dark'>('light');
	let settings = $state<GlobalSettings>({ ...defaultSettings });
	let settingsDialog = $state<HTMLDialogElement | undefined>();
	// The form is only rendered while open, so its controls never shadow the
	// page's own (e.g. "Show all activity") when the menu is closed.
	let settingsOpen = $state(false);
	let unseenActivity = $state(false);
	let showBottomJump = $state(false);
	let archiveNotice = $state<ArchiveNotice | null>(null);
	let sessionInfoDialog = $state<HTMLDialogElement | null>(null);
	let usageHistoryOpen = $state(false);
	let clearingSessionId = $state<string | null>(null);
	let clearReplacementId = $state<string | null>(null);
	let clearCreationSnapshot = $state<Set<string> | null>(null);
	let activityClock = $state(Date.now());
	let usageAnalysisByHost = $state<Record<string, ReturnType<typeof analyzeUsage>>>({});
	let fiveHourUsageAnalysisByHost = $state<Record<string, ReturnType<typeof analyzeUsage>>>({});
	const usageLoading = new Set<string>();
	const usageRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let archiveBrowserDialog = $state<HTMLDialogElement | null>(null);
	let archivedSessions = $state<ThreadSummary[]>([]);
	let archiveFilter = $state<ArchiveFilter>('all');
	let deletingAllArchives = $state(false);
	const visibleArchivedSessions = $derived(filterArchives(archivedSessions, hostChoices, archiveFilter));
	const deletableArchives = $derived(visibleArchivedSessions.filter((session) => archiveDeletionSupported(session, hostChoices)));
	let archivedSessionsLoading = $state(false);
	let archivedSessionsError = $state<string | null>(null);
	let restoringArchivedSessionId = $state<string | null>(null);
	let deletingArchivedSessionId = $state<string | null>(null);
	let interactiveChoiceDialog = $state<HTMLDialogElement | null>(null);
	let resolvedInteractiveQuestionIds = $state<Record<string, boolean>>({});
	let retainedInteractiveQuestions = $state<Array<{ id: string; threadId: string; question: string; options: string[] }>>([]);
	let choiceCustomAnswer = $state('');
	let choicePromptId = $state<string | null>(null);
	let instantTooltip = $state<{ text: string; left: number; top: number; wide: boolean } | null>(null);
	let instantTooltipTarget: Element | null = null;
	const internallyRemovedTitles = new WeakSet<Element>();
	// Read-only file browser (FileBrowser.svelte), rooted at the session cwd.
	let filesOpenBySession = $state<Record<string, boolean>>({});
	let filesRevealBySession = $state<Record<string, { path: string; line: number | null; root?: string | null; nonce: number } | null>>({});
	let fileChangeLineStats = $state<Record<string, { additions: number | null; deletions: number | null }>>({});
	let fileChangeStatsRequest = 0;
	let fileLinkPreview = $state<{ path: string; content: string } | null>(null);
	let restartPromptEchoes = $state<Record<string, string[]>>({});
	let suppressedRestartItemIds = $state<Record<string, string[]>>({});
	let copiedFileLink = $state<string | null>(null);
	let filesRefresh = $state(0);
	let filesToggleEl = $state<HTMLButtonElement | null>(null);
	let changesOpenBySession = $state<Record<string, boolean>>({});
	let changesRevealBySession = $state<Record<string, { path: string; nonce: number } | null>>({});
	let sidebarEl = $state<HTMLElement | null>(null);
	let sidebarToggleEl = $state<HTMLButtonElement | null>(null);
	let imageInputEl = $state<HTMLInputElement | null>(null);
	let composerTextareaEl = $state<HTMLTextAreaElement | null>(null);
	// Reasoning efforts offered by the active session's model (thread /model).
	let sessionModels = $state<Record<string, ModelChoice[]>>({});
	let modelEfforts = $state<Record<string, string[]>>({});
	let modelPending = $state(false);
	let switchingPromptModel = $state(false);
	let turnModels = $state<Record<string, string>>({});
	let turnEfforts = $state<Record<string, string>>({});
	let effortPending = $state(false);
	let accountUsageByHost = $state<Record<string, AccountUsage>>({});
	let accountUsageFetchedAt = $state<Record<string, number>>({});
	let accountUsagePending = $state<Record<string, boolean>>({});
	// Sub-agent threads spawned by sessions (multi-agent collaboration).
	let agents = $state<AgentRegistry>({});
	let activeTurnBySession = $state<Record<string, string>>({});
	let stoppingSessions = $state<Record<string, boolean>>({});
	let latestWorkOrderBySession = $state<Record<string, string>>({});
	let agentHistoryLoading = $state(false);
	// Agent threads whose metadata (nickname/role) was already requested.
	const agentMetaFetched = new Set<string>();
	let transcriptScrollTop = $state(0);
	let transcriptViewportHeight = $state(0);
	let transcriptHeightVersion = $state(0);
	let commandOutputExpanded = $state<Record<string, boolean>>({});
	// Per-message toggle between rendered and raw Markdown for Codex replies.
	let agentRawShown = $state<Record<string, boolean>>({});
	let agentCopyStatus = $state<Record<string, 'copied' | 'failed'>>({});
	let agentFileCopyStatus = $state<Record<string, 'copying' | 'copied' | 'failed'>>({});
	let agentCopyTimer: ReturnType<typeof setTimeout> | null = null;
	// Touch devices have no hover: a tap on a message stands in for it,
	// revealing that message's raw-Markdown toggle until a tap elsewhere.
	let hoverPointer = $state(true);
	let tappedAgentKey = $state<string | null>(null);
	const rowHeights = new Map<string, number>();
	// Per-session Up/Down message recall (codex TUI semantics; see $lib/history).
	const composerHistories = new Map<string, ComposerHistory>();
	const ESTIMATED_ROW_HEIGHT = 72;
	const VIRTUAL_OVERSCAN_PX = 700;
	const COMMAND_OUTPUT_COLLAPSE_CHARS = 1200;
	const MODEL_CAPACITY_ERROR = 'Selected model is at capacity. Please try a different model.';
	const FAST_SESSIONS_KEY = 'yacwu-fast-sessions';
	const RUNNING_TASKS_KEY = 'yacwu-running-tasks';
	const INTERRUPTED_SESSIONS_KEY = 'yacwu-interrupted-sessions';
	const FINISHED_SESSIONS_KEY = 'yacwu-finished-sessions';
	const DISMISSED_ATTENTION_KEY = 'yacwu-dismissed-attention';
	const RESOLVED_QUESTIONS_KEY = 'yacwu-resolved-questions';
	const TODO_QUEUES_KEY = 'yacwu-todo-queues';
	const RESTART_CONTINUATION_PROMPT =
		'The previous task was interrupted by an app restart. Continue from the current state: first inspect what is already complete, then finish only the remaining work.';
	const STOPPED_CONTINUATION_PROMPT =
		'The previous task was stopped. Continue from the current state: first inspect what is already complete, then finish only the remaining work.';
	let runningTasks: Record<string, string> = {};
	let todoQueues = $state<Record<string, TodoQueue>>({});
	// Session relay: server delivery records (the only source of sender
	// attribution) and each session's server-side message setting.
	let relayStore = $state(emptyRelayStore());
	let relaySeq = 0;
	let relayEnabled = $state<Record<string, boolean>>({});
	let archiveNoticeTimer: ReturnType<typeof setTimeout> | null = null;

	// The active session is whatever is in the URL (/s/<id>); / shows the welcome.
	const activeId = $derived(page.params.id ?? null);
	const filesOpen = $derived(activeId ? filesOpenBySession[activeId] ?? false : false);
	const filesReveal = $derived(activeId ? filesRevealBySession[activeId] ?? null : null);
	const changesOpen = $derived(activeId ? changesOpenBySession[activeId] ?? false : false);
	const changesReveal = $derived(activeId ? changesRevealBySession[activeId] ?? null : null);
	const active = $derived(activeId ? threads[activeId] : null);
	const activeSummary = $derived(sessions.find((s) => s.id === activeId) ?? null);
	const userPrompts = $derived.by(() =>
		itemsOf(active)
			.filter((item) => item.type === 'userMessage')
			.map((item) => ((item as any).content ?? [])
			.map((part: any) => typeof part?.text === 'string' ? visibleUserText(part.text) : '')
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim())
			.filter((prompt) => prompt !== RESTART_CONTINUATION_PROMPT)
			.filter((prompt) => prompt !== STOPPED_CONTINUATION_PROMPT)
			.filter(Boolean)
	);
	const originalPrompt = $derived(userPrompts[0] ?? '');
	const latestPrompt = $derived(userPrompts.at(-1) ?? '');
	const activeTodoQueue = $derived(activeId ? todoQueues[activeId] ?? null : null);
	const activeTodoOffset = $derived(activeTodoQueue?.initialTask ? 1 : 0);
	const activeTodoTotal = $derived(activeTodoQueue ? activeTodoQueue.tasks.length + activeTodoOffset : 0);
	const activeTodoPosition = $derived(activeTodoQueue ? activeTodoQueue.startedCount + activeTodoOffset : 0);
	const sessionContextLine = $derived(activeTodoQueue?.currentTask || latestPrompt || activeSummary?.name?.trim() || '');
	const sessionContextTitle = $derived.by(() => {
		const lines = [];
		if (activeTodoQueue?.tasks.length) {
			if (activeTodoTotal > 1) {
				lines.push(`Todos (${activeTodoTotal})`);
				if (activeTodoQueue.initialTask) {
					const runningInitialTask = activeTodoQueue.startedCount === 0 && active?.status === 'running';
					lines.push(`[1/${activeTodoTotal}] ${runningInitialTask ? 'Current' : 'Done'} · ${activeTodoQueue.initialTask}`);
				}
				activeTodoQueue.tasks.forEach((task, index) => {
					const position = index + 1 + activeTodoOffset;
					const state = index < activeTodoQueue.startedCount
						? index === activeTodoQueue.startedCount - 1 && activeTodoQueue.currentTask ? 'Current' : 'Done'
						: 'Queued';
					lines.push(`[${position}/${activeTodoTotal}] ${state} · ${task}`);
				});
			} else if (activeTodoQueue.currentTask) {
				lines.push(`Current todo [${activeTodoPosition}/${activeTodoTotal}]: ${activeTodoQueue.currentTask}`);
			}
		}
		if (activeSummary?.name?.trim()) lines.push(`Session: ${activeSummary.name.trim()}`);
		if (latestPrompt) lines.push(`Latest prompt: ${latestPrompt}`);
		if (originalPrompt && originalPrompt !== latestPrompt) lines.push(`Original prompt: ${originalPrompt}`);
		return lines.join('\n');
	});
	const pendingInteractiveQuestions = $derived.by(() => {
		if (!activeId || viewedAgentId) return [];
		const queue: Array<{ id: string; threadId: string; question: string; options: string[] }> = [];
		const threadIds = [activeId, ...agentsForSession(agents, activeId).map((agent) => agent.id)];
		for (const threadId of threadIds) {
			const items = itemsOf(threads[threadId] ?? null);
			queue.push(...pendingQuestionsForThread(items, threadId, resolvedInteractiveQuestionIds));
		}
		const combined = [...retainedInteractiveQuestions.filter((question) => threadIds.includes(question.threadId)), ...queue];
		const seen = new Set<string>();
		return combined.filter((question) => {
			const key = `${question.threadId}:${question.id}`;
			if (resolvedInteractiveQuestionIds[key] || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	});
	const pendingInteractiveChoice = $derived(pendingInteractiveQuestions[0] ?? null);
	$effect(() => {
		const pending = pendingInteractiveChoice;
		const pendingKey = pending ? `${pending.threadId}:${pending.id}` : null;
		if (pendingKey && pendingKey !== choicePromptId) {
			choicePromptId = pendingKey;
			choiceCustomAnswer = '';
		}
		if (!pending) {
			if (interactiveChoiceDialog?.open) interactiveChoiceDialog.close();
			return;
		}
		if (interactiveChoiceDialog && !interactiveChoiceDialog.open) interactiveChoiceDialog.showModal();
	});
	const activeConfig = $derived(activeId ? sessionConfigs[activeId] : null);
	const activeTurnModel = $derived(activeId ? turnModels[activeId] : null);
	const activeTurnEffort = $derived(activeId ? turnEfforts[activeId] : null);
	const activeModelChangedDuringTurn = $derived(
		active?.status === 'running' && Boolean(activeTurnModel) && Boolean(activeConfig?.model) && activeTurnModel !== activeConfig?.model
	);
	const activeEffortChangedDuringTurn = $derived(
		active?.status === 'running' && Boolean(activeTurnEffort) && Boolean(activeConfig?.effort) && activeTurnEffort !== activeConfig?.effort
	);
	const activeSettingsChangedDuringTurn = $derived(activeModelChangedDuringTurn || activeEffortChangedDuringTurn);
	const activeModels = $derived(activeId ? filterAndSortModelChoices(sessionModels[activeId] ?? []) : []);
	const activeClaude = $derived(isClaudeModelCatalog(activeModels));
	const activeEfforts = $derived(activeId ? (modelEfforts[activeId] ?? []) : []);
	const activeModelChoice = $derived.by(() => {
		const choice = activeConfig && activeId
			? sessionModels[activeId]?.find((choice) => choice.id === activeConfig.model) ?? null
			: null;
		return choice?.id === 'default' && isClaudeModelCatalog([choice])
			? { ...choice, displayName: choice.displayName.replace(/\s*\(default\)/gi, '').trim() }
			: choice;
	});
	const activePickerModel = $derived(
		activeClaude && activeModelChoice
			? activeModels.find((choice) => claudeModelIdentity(choice) === claudeModelIdentity(activeModelChoice))?.id ?? activeConfig?.model
			: activeConfig?.model
	);
	const activeHost = $derived(activeId ? sessionHost(activeId) : LOCAL_HOST);
	const activeRemote = $derived(isRemoteHost(activeHost));
	const activeAccountUsage = $derived(accountUsageByHost[activeHost] ?? null);
	const activeHostState = $derived(
		activeRemote ? (hostStates[activeHost] ?? 'connected') : 'connected'
	);
	// Side chats (ephemeral /btw forks) nest under their parent in the sidebar.
	// Orphans — whose parent was archived or isn't listed — stay top-level so
	// they remain reachable.
	const topSessions = $derived.by(() => {
		const roots = sessions.filter(
			(s) => s.id !== clearReplacementId && (!clearCreationSnapshot || clearCreationSnapshot.has(s.id))
				&& (!isSideChat(s) || !sessions.some((p) => p.id === s.forkedFromId))
		);
		const positions = new Map(sessionOrder.map((id, index) => [id, index]));
		return roots
			.map((session, index) => ({ session, index, position: positions.get(session.id) }))
			.sort((a, b) => {
				if (a.position !== undefined && b.position !== undefined) return a.position - b.position;
				if (a.position !== undefined) return 1;
				if (b.position !== undefined) return -1;
				return a.index - b.index;
			})
			.map(({ session }) => session);
	});
	const activeIsSide = $derived(Boolean(activeSummary && isSideChat(activeSummary)));
	const activeParent = $derived(
		activeIsSide ? (sessions.find((s) => s.id === activeSummary?.forkedFromId) ?? null) : null
	);
	// Sub-agents of the active session, in spawn order. Selecting one (via the
	// ?agent= query param) shows its transcript read-only; the session itself
	// stays the URL's identity, so the rail selection never moves.
	const activeAgents = $derived(activeId ? agentsForSession(agents, activeId) : []);
	function threadAttention(threadId: string): 'choice' | 'alert' | null {
		if (threads[threadId]?.error) return 'alert';
		const items = itemsOf(threads[threadId] ?? null);
		if (pendingQuestionsForThread(items, threadId, resolvedInteractiveQuestionIds).length
			|| retainedInteractiveQuestions.some((question) => question.threadId === threadId
				&& !resolvedInteractiveQuestionIds[`${threadId}:${question.id}`])) return 'choice';
		for (let index = items.length - 1; index >= 0; index--) {
			const item = items[index] as any;
			if (item.type === 'userMessage') return null;
			if (item.type === 'agentMessage') {
				if (!item._completed) continue;
				const kind = detectPromptKind(String(item.text ?? ''));
				if (kind === 'unknown' && dismissedAttentionByThread[threadId]) return null;
				return kind === 'unknown' ? 'alert' : null;
			}
		}
		return null;
	}
	const sessionAttentionById = $derived.by(() => {
		const result: Record<string, 'choice' | 'alert'> = {};
		for (const session of sessions) {
			const attention = [session.id, ...agentsForSession(agents, session.id).map((agent) => agent.id)]
				.map(threadAttention);
			if (attention.includes('alert')) result[session.id] = 'alert';
			else if (attention.includes('choice')) result[session.id] = 'choice';
		}
		return result;
	});
	const activeWorkOrderId = $derived(activeId ? latestWorkOrderBySession[activeId] ?? null : null);
	const currentAgents = $derived(
		activeAgents.filter(
			(agent) => agentIsRunning(agent) || Boolean(activeWorkOrderId && agent.workOrderId === activeWorkOrderId)
		)
	);
	const previousAgents = $derived(activeAgents.filter((agent) => !currentAgents.includes(agent)));
	const viewedAgentId = $derived(activeId ? page.url.searchParams.get('agent') : null);
	const viewedId = $derived(viewedAgentId ?? activeId);
	const viewed = $derived(viewedId ? (threads[viewedId] ?? null) : null);
	const viewedAgent = $derived(viewedAgentId ? (agents[viewedAgentId] ?? null) : null);
	function taskProgressForSession(id: string) {
		const items = itemsOf(threads[id] ?? null);
		let latestUserIndex = -1;
		for (let index = items.length - 1; index >= 0; index -= 1) {
			if (items[index].type === 'userMessage') {
				latestUserIndex = index;
				break;
			}
		}
		for (let index = items.length - 1; index > latestUserIndex; index -= 1) {
			const item = items[index] as any;
			if (item.type !== 'agentMessage') continue;
			const estimate = parseTaskProgress(String(item.text ?? ''));
			if (estimate) return estimate;
		}
		return null;
	}
	function estimatedSessionTimeLeft(id: string, progress: ReturnType<typeof taskProgressForSession>): string | null {
		if (!progress) return null;
		const startedAt = threads[id]?.turnStartedAt;
		const elapsed = threads[id]?.status === 'running' && startedAt !== null && startedAt !== undefined
			? activityClock - startedAt : 0;
		return formatEstimatedRemaining(estimateRemainingMinutes(progress.percent, progress.remainingMinutes, elapsed, isClaudeSession(id) && settings.claudeTimeCalibration));
	}
	const activeTaskProgress = $derived.by(() => {
		if (!activeId || !active || active.status !== 'running' || viewedAgentId) return null;
		const progress = taskProgressForSession(activeId);
		const startedAt = threads[activeId]?.turnStartedAt;
		return progress && startedAt !== null && startedAt !== undefined
			? { ...progress, remainingMinutes: estimateRemainingMinutes(progress.percent, progress.remainingMinutes, activityClock - startedAt, isClaudeSession(activeId) && settings.claudeTimeCalibration) }
			: progress;
	});
	const activeUsageAnalysis = $derived(usageAnalysisByHost[activeHost] ?? null);
	const activeFiveHourUsageAnalysis = $derived(fiveHourUsageAnalysisByHost[activeHost] ?? null);
	const activeTaskUsage = $derived.by(() => {
		const task = activeUsageAnalysis?.tasks.find((task) => task.threadId === activeId && task.host === activeHost && task.turnId === active?.turnId);
		return task && activeUsageAnalysis ? summarizeTaskAllowances(activeUsageAnalysis.tasks, task, activeFiveHourUsageAnalysis?.tasks ?? []) : null;
	});
	const projectedTaskUsage = $derived(projectTaskUsage(activeTaskUsage, activeTaskProgress, activityClock));
	const projectedFiveHourTaskUsage = $derived(projectTaskUsage(activeTaskUsage?.fiveHour ?? null, activeTaskProgress, activityClock));
	const completedUsageByItem = $derived.by(() => {
		const result: Record<string, TaskUsageSummary> = {};
		if (!activeUsageAnalysis || !viewedId) return result;
		const finals = new Map<string, string>();
		for (const item of itemsOf(viewed) as any[]) {
			if (item.type === 'agentMessage' && item.phase !== 'commentary' && item._turnId && item.text?.trim()) finals.set(item._turnId, item.id);
		}
		for (const task of activeUsageAnalysis.tasks) {
			if (task.host !== activeHost || task.threadId !== viewedId || task.endedAt === null) continue;
			const itemId = finals.get(task.turnId);
			if (itemId) result[itemId] = summarizeTaskAllowances(activeUsageAnalysis.tasks, task, activeFiveHourUsageAnalysis?.tasks ?? []);
		}
		return result;
	});

	async function refreshTaskUsage(host: string) {
		if (usageLoading.has(host)) return;
		usageLoading.add(host);
		try {
			const response = await fetch(`/api/usage${hostQuery(host)}`, { signal: AbortSignal.timeout(10_000) });
			if (!response.ok) return;
			const data = await response.json();
			usageAnalysisByHost[host] = analyzeUsage(data.events ?? [], { host });
			fiveHourUsageAnalysisByHost[host] = analyzeUsage(data.events ?? [], { host, windowDurationMins: 300 });
		} catch { /* Retain the last learned rates if telemetry is unavailable. */ }
		finally { usageLoading.delete(host); }
	}

	function scheduleTaskUsageRefresh(threadId: string) {
		const rootId = agents[threadId] ? agentRootId(agents, agents[threadId]) : threadId;
		const host = sessionHost(rootId);
		if (host !== activeHost || usageRefreshTimers.has(host)) return;
		usageRefreshTimers.set(host, setTimeout(() => {
			usageRefreshTimers.delete(host);
			void refreshTaskUsage(host);
		}, 500));
	}

	function thinkingCostLabel(effort: string) {
		const rate = activeUsageAnalysis?.rates.find((rate) => rate.model === activeConfig?.model && rate.effort === effort);
		const fiveHourRate = activeFiveHourUsageAnalysis?.rates.find((rate) => rate.model === activeConfig?.model && rate.effort === effort);
		return [{ rate, label: 'week' }, { rate: fiveHourRate, label: '5h' }].flatMap(({ rate: selected, label }) => {
			return selected?.percentPer100kTokens != null
				? [`${formatAllowancePercent(selected.percentPer100kTokens)} ${label}/100k${selected.estimate?.provisional ? ' · early' : ''}`] : [];
		}).join(' · ') || 'Learning…';
	}

	function fiveHourCostLabel(summary: TaskUsageSummary | undefined) {
		if (!summary || summary.knownPercent === null) return '';
		return `${formatAllowancePercent(summary.percent ?? summary.knownPercent)} 5h${summary.percent === null ? ' · incomplete' : ''}${summary.provisional ? ' · early' : ''}`;
	}

	function taskUsageTitle(summary: TaskUsageSummary) {
		const cost = summary.percent === null ? summary.knownPercent !== null
			? `Known weekly allowance subtotal: ${formatAllowancePercent(summary.knownPercent)}. Excludes ${summary.unestimatedTurns} turn(s) with incomplete recording or uncalibrated model/thinking or token mix; this is not the full task cost.`
			: 'Weekly allowance estimate unavailable until recording and calibration are sufficient.'
			: `Estimated weekly allowance: ${formatAllowancePercent(summary.percent)} (${summary.low?.toFixed(3)}–${summary.high?.toFixed(3)}%).`;
		const fiveHour = summary.fiveHour;
		const fiveHourCost = fiveHour?.knownPercent != null ? ` Independently estimated 5-hour allowance: ${fiveHourCostLabel(fiveHour)}.${fiveHour.low != null && fiveHour.high != null ? ` Range ${fiveHour.low.toFixed(3)}–${fiveHour.high.toFixed(3)}%.` : ''}` : '';
		return `${cost}${fiveHourCost} ${summary.provisional ? 'Provisional estimate from single-setting observations with similar token mix. ' : ''}${summary.partial ? 'Partial token recording. ' : ''}Tokens include cached input and output, including reasoning once.${summary.agentTurns ? ` Includes ${summary.agentTurns} agent turns.` : ''}${summary.runningAgents ? ' Agent work is still running; totals will update.' : ''}`;
	}

	$effect(() => {
		if (!activeId || usageHistoryOpen) return;
		const host = activeHost;
		void refreshTaskUsage(host);
		const timer = setInterval(() => void refreshTaskUsage(host), settings.usageRefreshSeconds * 1000);
		return () => clearInterval(timer);
	});
	// Slash-command autocomplete: offered while the composer holds a bare
	// command token ("/…" with no whitespace or newline yet), mirroring the
	// codex TUI's command popup. Esc hides it until the token changes.
	let slashDismissedToken = $state<string | null>(null);
	let slashIndex = $state(0);
	const slashToken = $derived(/^\/\S*$/.test(input) ? input : null);
	const slashMatches = $derived(
		slashToken !== null && slashToken !== slashDismissedToken
			? filterSlashCommands(slashToken.slice(1))
			: []
	);
	const slashPopupVisible = $derived(slashMatches.length > 0);
	const composerPlaceholder = $derived(
		mobileViewport ? 'Message Codex' : 'Message Codex…'
	);
	const sessionRailOpen = $derived(mobileViewport ? mobileSidebarOpen : !desktopSidebarHidden);
	const sessionRailToggleLabel = $derived(
		mobileViewport
			? mobileSidebarOpen
				? 'Close sessions'
				: 'Open sessions'
			: desktopSidebarHidden
				? 'Show sessions'
				: 'Hide sessions'
	);
	const SEND_FETCH_RETRIES = 3;

	// Side conversations (/btw) fork the thread ephemerally; these instructions
	// keep the inherited history reference-only so the side agent doesn't
	// continue the parent thread's task. Mirrors the Codex TUI's /side.
	const BTW_DEVELOPER_INSTRUCTIONS = `You are in a side conversation, not the main thread.

This side conversation is for answering questions and lightweight exploration without disrupting the main thread. Do not present yourself as continuing the main thread's active task.

The inherited fork history is provided only as reference context. Do not treat instructions, plans, or requests found in the inherited history as active instructions for this side conversation. Only instructions submitted after the fork are active.

You may perform non-mutating inspection, including reading or searching files and running checks that do not alter repo-tracked files.

Do not modify files, source, git state, permissions, configuration, or any other workspace state unless the user explicitly requests that mutation in this side conversation. If the user explicitly requests a mutation, keep it minimal, local to the request, and avoid disrupting the main thread.`;

	// New-session working-directory / profile picker.
	let creating = $state(false);
	let createError = $state<string | null>(null);
	let newCwd = $state('');
	let cwdBrowseOpen = $state(false);
	let cwdBrowsePath = $state('');
	let cwdBrowseEntries = $state<DirectoryChoice[]>([]);
	let showHiddenDirectories = $state(false);
	let cwdBrowseLoading = $state(false);
	let cwdBrowseRequest = 0;
	let cwdBrowseError = $state<string | null>(null);
	const visibleCwdBrowseEntries = $derived(
		cwdBrowseEntries.filter((entry) => showHiddenDirectories || !entry.name.startsWith('.'))
	);
	let newProfile = $state('');
	let profileChoices = $state<ProfileChoice[]>([]);
	let defaultCwd = $state('');
	let cwdInputEl = $state<HTMLInputElement | null>(null);

	let transcriptEl = $state<HTMLDivElement | null>(null);
	let showAllActivity = $state(false);
	let expandedActivity = $state<Record<string, boolean>>({});
	function toggleActivityGroup(id: string) {
		cancelBottomJump();
		const key = `${viewedId}:${id}`;
		expandedActivity[key] = !expandedActivity[key];
	}
	let sessionRules = $state<Record<string, SessionRules>>({});
	function saveSessionRules(id: string, rules: SessionRules) {
		sessionRules = { ...sessionRules, [id]: rules };
		try { localStorage.setItem(SESSION_RULES_KEY, JSON.stringify(sessionRules)); return true; }
		catch { showArchiveNotice({ tone: 'error', message: 'Rules apply for now, but could not be saved in this browser.' }); return false; }
	}
	// The transcript renders whichever thread is in view: the session itself,
	// or a selected sub-agent's thread.
	const viewedItems = $derived(
		separateTaskProgressEntries(itemsOf(viewed)).filter(isRenderableTranscriptItem)
	);
	// Agents the backend announced itself (Codex's subAgentActivity). Spawns
	// without one (the Claude adapter) get an equivalent "Started" row.
	const announcedAgents = $derived(
		new Set(viewedItems.flatMap((item: any) => (item.type === 'subAgentActivity' && item.agentThreadId ? [item.agentThreadId] : [])))
	);
	const displayedItems = $derived(showAllActivity ? viewedItems : compactActivity(viewedItems, (id) => Boolean(expandedActivity[`${viewedId}:${id}`]), viewed?.status === 'running'));
	const virtualTranscript = $derived(
		virtualizeItems(displayedItems, transcriptScrollTop, transcriptViewportHeight, transcriptHeightVersion)
	);
	const transcriptJumpPoints = $derived.by(() => {
		const total = Math.max(1, virtualTranscript.total);
		let offset = 0;
		const points: { id: string; index: number; offset: number; top: number; label: string }[] = [];
		for (let index = 0; index < displayedItems.length; index += 1) {
			const item = displayedItems[index];
			if (item.type === 'userMessage') {
				const rawText = ((item as any).content ?? [])
					.map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
					.join(' ')
					.trim();
				points.push({
					id: String((item as any).id ?? index),
					index,
					offset,
					top: Math.max(2, Math.min(98, (offset / total) * 100)),
					label: truncateText(rawText || 'User message', 72)
				});
			}
			offset += measuredRowHeight(item);
		}
		return points;
	});
	const activeTranscriptPointId = $derived.by(() => {
		const readingLine = transcriptScrollTop + Math.min(120, transcriptViewportHeight * 0.25);
		let current: string | null = transcriptJumpPoints[0]?.id ?? null;
		for (const point of transcriptJumpPoints) {
			if (point.offset > readingLine) break;
			current = point.id;
		}
		return current;
	});

	function ensureThread(id: string): ThreadState {
		if (!threads[id]) {
			threads[id] = {
				order: [],
				byId: {},
				status: 'idle',
				turnId: null,
				tokens: null,
				contextWindow: null,
				error: null,
				goal: null,
				turnStartedAt: null
			};
		}
		return threads[id];
	}

	// Keep unsent text with the session it belongs to; a route change saves the
	// old draft and restores the destination session's draft.
	$effect(() => {
		const id = activeId;
		untrack(() => {
			if (promptDraftSessionId === id) {
				if (id) promptDrafts[id] = input;
				return;
			}
			if (promptDraftSessionId) promptDrafts[promptDraftSessionId] = input;
			input = id ? (promptDrafts[id] ?? '') : '';
			promptDraftSessionId = id;
		});
	});

	function upsertItem(
		id: string,
		item: ThreadItem & { id: string },
		stampTime = false,
		historicalWorkOrderId?: string,
		completed = false
	) {
		const t = ensureThread(id);
		if (!t.byId[item.id]) t.order.push(item.id);
		// Preserve any locally-accumulated streamed text across updates.
		const prev = t.byId[item.id] as any;
		const next = { ...item } as any;
		if (next._turnId === undefined) next._turnId = historicalWorkOrderId ?? prev?._turnId ?? t.turnId;
		if (prev) {
			if (prev._completed) next._completed = true;
			if (next.text === '' && prev.text) next.text = prev.text;
			if (next._reason === undefined && prev._reason) next._reason = prev._reason;
			if (next._out === undefined && prev._out) next._out = prev._out;
			if (next._at === undefined && prev._at) next._at = prev._at;
			if (next._turnDurationMs === undefined && prev._turnDurationMs !== undefined) next._turnDurationMs = prev._turnDurationMs;
		} else if (stampTime) {
			// The protocol has no per-item timestamps; live items are stamped
			// with arrival time. Restored history stays unstamped.
			next._at = Date.now();
		}
		if (completed) next._completed = true;
		if (next.type === 'agentMessage' && typeof next.text === 'string') next.text = visibleAgentMessageText(next.text);
		t.byId[item.id] = next;
		// Collaboration items reveal sub-agent threads; keep the registry live
		// for both streamed items and restored history.
		if (next.type === 'collabAgentToolCall' || next.type === 'subAgentActivity') {
			const rootId = agents[id] ? agentRootId(agents, agents[id]) : id;
			const workOrderId =
				rootId === id && historicalWorkOrderId
					? historicalWorkOrderId
					: activeTurnBySession[rootId] ?? latestWorkOrderBySession[rootId] ?? null;
			trackAgentItem(agents, id, next, workOrderId);
			if (workOrderId) latestWorkOrderBySession[rootId] = workOrderId;
		}
	}

	function syncThreadRuntime(id: string, thread: { status?: { type: string }; turns?: Turn[] }) {
		const t = ensureThread(id);
		const runtimeStatus = thread.status?.type;
		if (runtimeStatus === 'active') {
			clearStoppedResumeActions(id);
			t.status = 'running';
			if (t.turnStartedAt === null) t.turnStartedAt = Date.now();
			const turn = thread.turns?.findLast((turn) => turn.status === 'inProgress');
			if (turn?.id) {
				t.turnId = turn.id;
				activeTurnBySession[id] = turn.id;
			}
		} else if (runtimeStatus === 'idle' || runtimeStatus === 'notLoaded') {
			t.status = 'idle';
			t.turnStartedAt = null;
			t.turnId = null;
			delete activeTurnBySession[id];
			markTaskCompleted(id);
		}
	}

	function replaceItems(id: string, turns: Turn[]) {
		const t = ensureThread(id);
		t.order = [];
		t.byId = {};
		// Restored history carries the backend's own userMessage items;
		// any optimistic copies were wiped with the transcript above.
		pendingUserEchoes[id] = [];
		for (const turn of turns) {
			for (const item of turn.items ?? []) {
				if ((item as any).id) upsertItem(id, item as any, false, turn.id, turn.status !== 'inProgress');
			}
		}
	}

	/** The host a session runs on: its summary's tag, the URL hint, or local. */
	/** Claude sessions get their stated time-left checked against the elapsed pace. */
	function isClaudeSession(id: string | null): boolean {
		const host = sessionHost(id);
		return hostChoices.some((entry) => entry.name === host && entry.provider === 'claude');
	}

	function sessionHost(id: string | null): string {
		if (!id) return LOCAL_HOST;
		const summary = sessions.find((s) => s.id === id);
		if (summary?.host) return summary.host;
		if (page.params.id === id) {
			const hinted = page.url.searchParams.get('host');
			if (hinted) return hinted;
		}
		return LOCAL_HOST;
	}

	function sharedChannelPathForSession(id: string): string | null {
		const summary = sessions.find((session) => session.id === id);
		return sharedChannelPath(sessionHost(id), cwds[id] ?? summary?.cwd ?? '', hostChoices);
	}

	async function addSharedChannelContext(id: string, text: string): Promise<string> {
		const host = sessionHost(id);
		if (host !== LOCAL_HOST && !hostChoices.some((entry) => entry.name === host)) await loadHostChoices();
		const visibleText = visibleUserText(text);
		const path = sharedChannelPathForSession(id);
		const alreadyJoined = itemsOf(threads[id] ?? null).some((item) => {
			if (item.type !== 'userMessage') return false;
			return ((item as any).content ?? []).some(
				(part: any) => typeof part?.text === 'string' && hasSharedChannelContext(part.text, path ?? undefined)
			);
		});
		return !path || alreadyJoined ? visibleText : withSharedChannelContext(visibleText, path, id);
	}

	async function loadHostChoices() {
		try {
			const response = await fetch('/api/hosts', { signal: AbortSignal.timeout(5_000) });
			if (!response.ok) return;
			const data = await response.json();
			hostChoices = (data.hosts ?? []) as HostInfo[];
			for (const host of hostChoices) {
				if (host.kind === 'remote' && !(host.name in hostStates)) hostStates[host.name] = host.state;
			}
		} catch { /* Keep known targets when discovery is temporarily unavailable. */ }
	}

	/** Thread API URL carrying the session's host as a routing hint. */
	function threadApi(id: string, path = '', hostOverride?: string): string {
		return `/api/threads/${id}${path}${hostQuery(hostOverride ?? sessionHost(id))}`;
	}

	function upsertSession(thr: any) {
		if (!thr?.id) return;
		if (thr.cwd) cwds[thr.id] = thr.cwd;
		const now = Math.floor(Date.now() / 1000);
		// Preserve relationship metadata when a payload omits it (codex reports
		// forkedFromId only in the thread/fork response, not on later reads).
		const existing = sessions.find((s) => s.id === thr.id);
		const summary: ThreadSummary = {
			id: thr.id,
			preview: thr.preview ?? '',
			name: thr.name ?? null,
			createdAt: thr.createdAt ?? existing?.createdAt ?? now,
			updatedAt: thr.updatedAt ?? thr.createdAt ?? existing?.updatedAt ?? now,
			cwd: thr.cwd,
			forkedFromId: thr.forkedFromId ?? existing?.forkedFromId ?? null,
			ephemeral: thr.ephemeral ?? existing?.ephemeral ?? false,
			host: thr.host ?? existing?.host ?? undefined
		};
		sessions = [summary, ...sessions.filter((s) => s.id !== thr.id)];
	}

	function touchSession(id: string, timestamp: unknown) {
		const updatedAt =
			typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
				? Math.floor(timestamp)
				: Math.floor(Date.now() / 1000);
		sessions = sessions.map((session) =>
			session.id === id ? { ...session, updatedAt } : session
		);
	}

	function reorderSession(draggedId: string, targetId: string) {
		const ids = topSessions.map((session) => session.id);
		const from = ids.indexOf(draggedId);
		const to = ids.indexOf(targetId);
		if (from < 0 || to < 0 || from === to) return;
		ids.splice(to, 0, ids.splice(from, 1)[0]);
		sessionOrder = ids;
		localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(ids));
	}

	function moveSessionByKeyboard(id: string, offset: -1 | 1) {
		const ids = topSessions.map((session) => session.id);
		const index = ids.indexOf(id);
		const target = ids[index + offset];
		if (target) reorderSession(id, target);
	}

	function startSessionDrag(event: PointerEvent, id: string) {
		if (event.button !== 0) return;
		suppressSessionClickId = null;
		pointerSessionDrag = {
			id,
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			targetId: null,
			active: false
		};
		draggingSessionId = id;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function startWorkspaceResize(event: PointerEvent) {
		if (event.button !== 0) return;
		event.preventDefault();
		workspaceResizePointerId = event.pointerId;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function resizeWorkspace(event: PointerEvent) {
		if (workspaceResizePointerId !== event.pointerId || !workspaceSplitEl) return;
		const rect = workspaceSplitEl.getBoundingClientRect();
		const position = mobileViewport ? event.clientY - rect.top : event.clientX - rect.left;
		const size = mobileViewport ? rect.height : rect.width;
		if (size <= 0) return;
		workspaceSplitRatio = Math.max(0.2, Math.min(0.7, position / size));
		localStorage.setItem(WORKSPACE_SPLIT_KEY, String(workspaceSplitRatio));
	}

	function finishWorkspaceResize(event: PointerEvent) {
		if (workspaceResizePointerId === event.pointerId) workspaceResizePointerId = null;
	}

	function nudgeWorkspaceSplit(event: KeyboardEvent) {
		const towardFirstPane = mobileViewport ? event.key === 'ArrowUp' : event.key === 'ArrowLeft';
		const towardSecondPane = mobileViewport ? event.key === 'ArrowDown' : event.key === 'ArrowRight';
		if (!towardFirstPane && !towardSecondPane) return;
		event.preventDefault();
		workspaceSplitRatio = Math.max(0.2, Math.min(0.7, workspaceSplitRatio + (towardFirstPane ? -0.02 : 0.02)));
		localStorage.setItem(WORKSPACE_SPLIT_KEY, String(workspaceSplitRatio));
	}

	function dismissGoalBar(id: string, objective: string) {
		dismissedGoalBySession = { ...dismissedGoalBySession, [id]: objective };
		localStorage.setItem(DISMISSED_GOALS_KEY, JSON.stringify(dismissedGoalBySession));
	}

	function moveSessionDrag(event: PointerEvent) {
		const drag = pointerSessionDrag;
		if (!drag || drag.pointerId !== event.pointerId) return;
		if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
		const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-session-row-id]');
		const targetId = target?.dataset.sessionRowId ?? null;
		pointerSessionDrag = { ...drag, active: true, targetId };
		dragOverSessionId = targetId;
	}

	function finishSessionDrag(event: PointerEvent) {
		const drag = pointerSessionDrag;
		if (drag && drag.pointerId === event.pointerId && drag.active && drag.targetId) {
			reorderSession(drag.id, drag.targetId);
			suppressSessionClickId = drag.id;
		}
		pointerSessionDrag = null;
		draggingSessionId = null;
		dragOverSessionId = null;
	}

	function activateSessionLink(event: MouseEvent, id: string) {
		if (suppressSessionClickId === id) {
			event.preventDefault();
			suppressSessionClickId = null;
			return;
		}
		clearFinishedSession(id);
		markSessionAttentionRead(id);
		closeSidebar(false);
	}

	function clearFinishedSession(id: string) {
		if (!finishedSessions[id]) return;
		const { [id]: _read, ...remaining } = finishedSessions;
		finishedSessions = remaining;
		localStorage.setItem(FINISHED_SESSIONS_KEY, JSON.stringify(remaining));
	}

	function markSessionAttentionRead(id: string) {
		const threadIds = [id, ...agentsForSession(agents, id).map((agent) => agent.id)];
		const next = { ...dismissedAttentionByThread };
		for (const threadId of threadIds) {
			if (!threads[threadId]?.error) next[threadId] = true;
		}
		dismissedAttentionByThread = next;
		localStorage.setItem(DISMISSED_ATTENTION_KEY, JSON.stringify(next));
	}

	function markSessionFinished(id: string) {
		if (id === activeId || threads[id]?.error) return;
		if (Object.values(agents).some((agent) => agentRootId(agents, agent) === id && threads[agent.id]?.status === 'running')) return;
		finishedSessions = { ...finishedSessions, [id]: true };
		localStorage.setItem(FINISHED_SESSIONS_KEY, JSON.stringify(finishedSessions));
	}

	function removeSession(id: string) {
		rememberEmptySession(id, null);
		sessions = sessions.filter((s) => s.id !== id);
		sessionOrder = sessionOrder.filter((sessionId) => sessionId !== id);
		localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(sessionOrder));
		delete activeTurnBySession[id];
		delete latestWorkOrderBySession[id];
		const { [id]: _removedTodoQueue, ...remainingTodoQueues } = todoQueues;
		todoQueues = remainingTodoQueues;
		persistTodoQueues();
		if (interruptedSessions[id]) {
			delete interruptedSessions[id];
			persistInterruptedSessions();
		}
		if (finishedSessions[id]) clearFinishedSession(id);
		const relatedAttentionIds = [id, ...agentsForSession(agents, id).map((agent) => agent.id)];
		const remainingAttention = { ...dismissedAttentionByThread };
		for (const threadId of relatedAttentionIds) delete remainingAttention[threadId];
		dismissedAttentionByThread = remainingAttention;
		localStorage.setItem(DISMISSED_ATTENTION_KEY, JSON.stringify(remainingAttention));
		for (const agent of Object.values(agents)) {
			if (agentRootId(agents, agent) === id) {
				delete agents[agent.id];
				delete threads[agent.id];
			}
		}
		delete threads[id];
		delete sessionConfigs[id];
		delete sessionModels[id];
		delete modelEfforts[id];
		delete fastSessions[id];
		persistFastSessions();
		delete cwds[id];
		composerHistories.delete(id);
		for (const key of Object.keys(commandOutputExpanded)) {
			if (key.startsWith(`${id}:`)) delete commandOutputExpanded[key];
		}
		for (const key of Object.keys(agentRawShown)) {
			if (key.startsWith(`${id}:`)) delete agentRawShown[key];
		}
		sessionStorage.removeItem(sideParentKey(id));
	}

	function persistFastSessions() {
		localStorage.setItem(
			FAST_SESSIONS_KEY,
			JSON.stringify(Object.keys(fastSessions).filter((id) => fastSessions[id]))
		);
	}

	function persistRunningTasks() {
		localStorage.setItem(RUNNING_TASKS_KEY, JSON.stringify(runningTasks));
	}

	function persistInterruptedSessions() {
		localStorage.setItem(
			INTERRUPTED_SESSIONS_KEY,
			JSON.stringify(Object.keys(interruptedSessions).filter((id) => interruptedSessions[id]))
		);
	}

	function markTaskStarted(threadId: string) {
		clearStoppedResumeActions(threadId);
		const agent = agents[threadId];
		const sessionId = agent ? agentRootId(agents, agent) : threadId;
		runningTasks[threadId] = sessionId;
		delete recoveringSessions[sessionId];
		if (interruptedSessions[sessionId]) {
			delete interruptedSessions[sessionId];
			persistInterruptedSessions();
		}
		persistRunningTasks();
	}

	function markTaskCompleted(threadId: string) {
		const sessionId = runningTasks[threadId];
		delete runningTasks[threadId];
		if (sessionId) delete recoveringSessions[sessionId];
		persistRunningTasks();
	}

	function stampTurnDuration(threadId: string, durationMs: number) {
		const thread = ensureThread(threadId);
		for (let i = thread.order.length - 1; i >= 0; i -= 1) {
			const item = thread.byId[thread.order[i]] as any;
			if (item?.type === 'agentMessage' && item.phase !== 'commentary' && item.text?.trim()) {
				item._turnDurationMs = durationMs;
				return;
			}
		}
	}

	function formatDuration(durationMs: number): string {
		const totalSeconds = Math.floor(durationMs / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
		if (minutes > 0) return `${minutes}m ${seconds}s`;
		return `${seconds}s`;
	}

	$effect(() => {
		if (!sessions.some((session) => threads[session.id]?.status === 'running')) return;
		const timer = window.setInterval(() => activityClock = Date.now(), 1000);
		return () => window.clearInterval(timer);
	});

	const viewedTurnElapsed = $derived.by(() => {
		activityClock;
		const started = viewed?.turnStartedAt;
		return viewed?.status === 'running' && started !== null && started !== undefined
			? formatDuration(Math.max(0, activityClock - started))
			: null;
	});

	function persistTodoQueues() {
		localStorage.setItem(TODO_QUEUES_KEY, JSON.stringify(todoQueues));
	}

	function queueTodo(id: string, task: string) {
		const existing = todoQueues[id] ?? {
			tasks: [], startedCount: 0, currentTask: null,
			initialTask: threads[id]?.status === 'running'
				? (itemsOf(threads[id]).filter((item) => item.type === 'userMessage').at(-1) as any)
					?.content?.map((part: any) => typeof part?.text === 'string' ? visibleUserText(part.text) : '').join('').trim() || 'Current task'
				: null
		};
		const queue = { ...existing, tasks: [...existing.tasks, task] };
		todoQueues = { ...todoQueues, [id]: queue };
		persistTodoQueues();
		addLocalNote(id, `Todo queued (${queue.tasks.length + (queue.initialTask ? 1 : 0)} total).`, 'info');
		if (sessionHistoryLoaded[id] && threads[id]?.status !== 'running') advanceTodoQueue(id);
	}

	function advanceTodoQueue(id: string) {
		const existing = todoQueues[id];
		if (!existing) return;
		if (existing.startedCount >= existing.tasks.length) {
			const { [id]: _finished, ...remaining } = todoQueues;
			todoQueues = remaining;
			persistTodoQueues();
			return;
		}
		const task = existing.tasks[existing.startedCount];
		const queue = { ...existing, startedCount: existing.startedCount + 1, currentTask: task };
		todoQueues = { ...todoQueues, [id]: queue };
		persistTodoQueues();
		void startQueuedTodo(id, task, queue);
	}

	function reconcileTodoQueue(id: string, runtimeStatus: string | undefined) {
		if (!todoQueues[id] || runtimeStatus === 'active' || runtimeStatus === 'notLoaded') return;
		if (runtimeStatus === 'idle') advanceTodoQueue(id);
	}

	async function startQueuedTodo(id: string, task: string, queue: TodoQueue) {
		const thread = ensureThread(id);
		thread.status = 'running';
		thread.turnStartedAt = Date.now();
		thread.turnId = null;
		thread.error = null;
		const echoId = addLocalUserMessage(id, task);
		try {
			const response = await sendMessageWithRetries(id, task, []);
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.error ?? `failed to start todo (${response.status})`);
			}
		} catch (error) {
			thread.status = 'idle';
			thread.turnStartedAt = null;
			removeLocalItem(id, echoId);
			const retryable = { ...queue, startedCount: Math.max(0, queue.startedCount - 1), currentTask: null };
			todoQueues = { ...todoQueues, [id]: retryable };
			persistTodoQueues();
			addLocalNote(id, `Could not start queued todo: ${error instanceof Error ? error.message : String(error)}`, 'err');
		}
	}

	let reconcilingRuntime = false;
	async function reconcileInterruptedSessions() {
		if (reconcilingRuntime) return;
		reconcilingRuntime = true;
		const checking = new Set<string>();
		try {
			const rawRunning = JSON.parse(localStorage.getItem(RUNNING_TASKS_KEY) ?? '{}');
			const previouslyRunning = rawRunning && typeof rawRunning === 'object' && !Array.isArray(rawRunning)
				? rawRunning as Record<string, string>
				: {};
			runningTasks = { ...previouslyRunning };
			for (const [id, thread] of Object.entries(threads)) {
				if (thread.status === 'running' && thread.turnStartedAt !== null && Date.now() - thread.turnStartedAt > 15000) {
					previouslyRunning[id] = agents[id] ? agentRootId(agents, agents[id]) : id;
					runningTasks[id] = previouslyRunning[id];
				}
			}
			const rawInterrupted = JSON.parse(localStorage.getItem(INTERRUPTED_SESSIONS_KEY) ?? '[]');
			if (Array.isArray(rawInterrupted)) {
				for (const id of rawInterrupted) if (typeof id === 'string') interruptedSessions[id] = true;
			}
			for (const sessionId of Object.values(previouslyRunning)) {
				if (!startupRecoveryComplete && typeof sessionId === 'string' && !interruptedSessions[sessionId]) {
					recoveringSessions[sessionId] = true;
					checking.add(sessionId);
				}
			}
			if (Object.keys(previouslyRunning).length === 0) return;
			const response = await fetch('/api/threads/loaded', { signal: AbortSignal.timeout(5000) });
			if (!response.ok) return;
			const data = await response.json();
			const loaded = new Set<string>(Array.isArray(data.data) ? data.data : []);
			await Promise.all(Object.entries(previouslyRunning).map(async ([threadId, sessionId]) => {
				const observedTurnId = threads[threadId]?.turnId;
				try {
					let outcome: ReturnType<typeof runtimeOutcome> = 'interrupted';
					let thread: { status?: { type: string }; turns?: Turn[] } = { status: { type: 'idle' } };
					if (loaded.has(threadId)) {
						const url = new URL(threadApi(threadId), window.location.origin);
						url.searchParams.set('turns', '1');
						const read = await fetch(url, { signal: AbortSignal.timeout(5000) });
						if (!read.ok) return;
						const data = await read.json();
						if (!data.thread) return;
						thread = data.thread;
						outcome = runtimeOutcome(thread);
					}
					// A new streamed turn must not be overwritten by an older read.
					if (threads[threadId]?.turnId !== observedTurnId) return;
					if (outcome === 'unknown' || outcome === 'running') return;
					syncThreadRuntime(threadId, thread);
					const latest = thread.turns?.at(-1);
					for (const item of latest?.items ?? []) upsertItem(threadId, item, false, latest?.id, true);
					if (outcome === 'interrupted' && !interruptedSessions[sessionId]) {
						interruptedSessions[sessionId] = true;
						addLocalNote(sessionId, `Task interrupted.\nReason: ${interruptionReason(thread, loaded.has(threadId))}\nUse Continue interrupted task to resume.`, 'err');
					}
				} catch { /* Unreachable is not proof of interruption; retain state. */ }
			}));
			for (const sessionId of checking) delete recoveringSessions[sessionId];
			persistRunningTasks();
			persistInterruptedSessions();
		} catch {
			// Keep the saved markers intact if storage or the backend is unavailable.
		} finally {
			reconcilingRuntime = false;
			for (const sessionId of checking) delete recoveringSessions[sessionId];
		}
	}

	function setFastSession(id: string, enabled: boolean) {
		fastSessions[id] = enabled;
		persistFastSessions();
	}

	/** Optimistically append the just-sent user message to the transcript.
	    Not every backend echoes a userMessage item back through the live
	    stream (claude-codex keeps it on the turn record only), so the sent
	    message would otherwise never appear until a reload. */
	function addLocalUserMessage(id: string, text: string, attachments: SelectedAttachment[] = []): string {
		const itemId = `local-user-${++localCounter}`;
		const attachmentNames = attachments.filter((item) => item.kind === 'file').map((item) => item.name);
		const displayText = attachmentNames.length
			? `${text}${text ? '\n\n' : ''}Attached files: ${attachmentNames.join(', ')}`
			: text;
		upsertItem(
			id,
			{ type: 'userMessage', id: itemId, content: [{ type: 'text', text: displayText }] } as any,
			true
		);
		(pendingUserEchoes[id] ??= []).push({ id: itemId, text });
		// Sending is an explicit request to follow the new turn, even if the
		// transcript was scrolled up before sending a large block of text.
		if (id === activeId) scrollToBottom();
		return itemId;
	}

	function removeLocalItem(id: string, itemId: string) {
		const t = threads[id];
		if (t) {
			delete t.byId[itemId];
			t.order = t.order.filter((existing) => existing !== itemId);
		}
		const queue = pendingUserEchoes[id];
		if (queue) pendingUserEchoes[id] = queue.filter((entry) => entry.id !== itemId);
	}

	/** A backend userMessage item supersedes a matching optimistic copy. */
	function dropEchoedUserMessage(id: string, item: any) {
		const queue = pendingUserEchoes[id];
		if (!queue?.length) return;
		const text = (item.content ?? [])
			.map((c: any) => (typeof c?.text === 'string' ? visibleUserText(c.text) : ''))
			.join('');
		const match = queue.find((entry) => entry.text === text);
		if (match && (match.text === text || text.startsWith(match.text))) removeLocalItem(id, match.id);
	}

	function suppressRestartPromptEcho(id: string, item: any, completed: boolean): boolean {
		const suppressedIds = suppressedRestartItemIds[id] ?? [];
		if (suppressedIds.includes(item.id)) {
			if (completed) suppressedRestartItemIds[id] = suppressedIds.filter((itemId) => itemId !== item.id);
			return true;
		}
		const text = (item.content ?? [])
			.map((part: any) => typeof part?.text === 'string' ? visibleUserText(part.text) : '')
			.join('')
			.trim();
		const queue = restartPromptEchoes[id] ?? [];
		const match = queue.findIndex((prompt) => prompt === text);
		if (match < 0) return false;
		restartPromptEchoes[id] = queue.filter((_, index) => index !== match);
		suppressedRestartItemIds[id] = [...suppressedIds, item.id];
		return true;
	}

	function clearStoppedResumeActions(id: string) {
		const thread = threads[id];
		if (!thread) return;
		for (const itemId of thread.order) {
			const item = thread.byId[itemId] as any;
			if (item?.type === 'localNote' && item.resumeAvailable) {
				thread.byId[itemId] = { ...item, resumeAvailable: false };
			}
		}
	}

	/** Append a client-side note (slash-command echo / help / errors). */
	function addLocalNote(id: string, text: string, tone: 'info' | 'err' = 'info') {
		const shouldScroll = id === activeId && isTranscriptAtBottom();
		const t = ensureThread(id);
		const noteId = `local-${++localCounter}`;
		t.order.push(noteId);
		t.byId[noteId] = { type: 'localNote', id: noteId, text, tone, resumeAvailable: text === 'Task stopped.' } as any;
		if (shouldScroll) scrollToBottom();
	}

	function addStalledWorkerPrompt(sessionId: string, workerId: string, turnId: string, worker: string, minutes: number) {
		const shouldScroll = sessionId === activeId && isTranscriptAtBottom();
		const t = ensureThread(sessionId);
		const id = `stalled-${++localCounter}`;
		t.order.push(id);
		t.byId[id] = {
			type: 'stalledWorkerPrompt', id, workerId, turnId, worker, minutes,
			text: `${worker} has had no Codex activity for ${minutes} minutes. It may still be reasoning or waiting on a tool; Yacwu has not stopped it.`
		} as any;
		if (shouldScroll) scrollToBottom();
	}

	function dismissStalledWorkerPrompt(sessionId: string, id: string) {
		removeLocalItem(sessionId, id);
	}

	async function askStalledWorkerStatus(sessionId: string, item: any) {
		const agent = agents[item.workerId];
		const prompt = agent
			? `Please check on ${agentLabel(agent)} (${agent.path ?? item.workerId}), get a brief status, and report it. Keep waiting unless it is actually blocked; do not interrupt it.`
			: 'Please provide a brief status update on your current work, then continue. Do not stop the task.';
		const t = ensureThread(sessionId);
		const wasRunning = t.status === 'running';
		const echoId = addLocalUserMessage(sessionId, prompt);
		try {
			const response = await sendMessageWithRetries(sessionId, prompt, [], wasRunning ? t.turnId : null);
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.error ?? `Status request failed (${response.status})`);
			}
			dismissStalledWorkerPrompt(sessionId, item.id);
			addLocalNote(sessionId, 'Status request sent to Codex.');
		} catch (error) {
			removeLocalItem(sessionId, echoId);
			addLocalNote(sessionId, `Could not send status request: ${error instanceof Error ? error.message : String(error)}`, 'err');
		}
	}

	async function stopStalledWorker(sessionId: string, item: any) {
		const stopped = await interruptThread(item.workerId, sessionHost(sessionId));
		if (stopped) dismissStalledWorkerPrompt(sessionId, item.id);
	}

	function handleNotification(msg: JsonRpcNotification) {
		const p: any = msg.params ?? {};
		const tid: string | undefined = p.threadId;
		const affectedThreadId: string | undefined = tid ?? p.thread?.id;
		const shouldScroll = affectedThreadId === viewedId && isTranscriptAtBottom();
		if (tid && clearsStalledWorkerPrompt(msg.method)) {
			for (const [sessionId, thread] of Object.entries(threads)) {
				for (const id of [...thread.order]) {
					const item = thread.byId[id] as any;
					if (item?.type === 'stalledWorkerPrompt' && item.workerId === tid) dismissStalledWorkerPrompt(sessionId, id);
				}
			}
		}

		switch (msg.method) {
			case 'yacwu/diagnostic/stalled': {
				const workerId = String(p.threadId ?? '');
				if (!workerId || !settings.quietWorkerNotices) break;
				const silentSeconds = Math.max(120, Number(p.silentSeconds) || 120);
				const minutes = Math.floor(silentSeconds / 60);
				const agent = agents[workerId];
				const sessionId = agent ? agentRootId(agents, agent) : workerId;
				const worker = agent ? agentLabel(agent) : 'Worker';
				const duplicate = itemsOf(threads[sessionId] ?? null).some((item: any) =>
					item.type === 'stalledWorkerPrompt' && item.workerId === workerId && item.turnId === String(p.turnId ?? '')
				);
				if (!duplicate) addStalledWorkerPrompt(sessionId, workerId, String(p.turnId ?? ''), worker, minutes);
				break;
			}
			case 'yacwu/relay/update': {
				const record = p.message as RelayRecord | undefined;
				if (record?.id && typeof p.epoch === 'string') {
					relayStore = applyRelayEvent(relayStore, p.epoch, record, ++relaySeq);
					noteRelayRecord(relayStore.records[record.id] ?? record);
				}
				break;
			}
			case 'yacwu/host/status': {
				const host = String(p.host ?? '');
				if (!host) break;
				const previous = hostStates[host];
				hostStates[host] = String(p.state ?? 'disconnected');
				// A host coming back means notifications were missed while it was
				// away: refresh the rail and resync the open transcript from
				// thread/read, the reconciliation source of truth.
				if (hostStates[host] === 'connected' && previous && previous !== 'connected') {
					void loadSessions();
					if (activeId && sessionHost(activeId) === host) {
						sessionHistoryLoaded[activeId] = false;
						void openSession(activeId, false);
					}
				}
				break;
			}

			case 'thread/started': {
				const thr = p.thread;
				if (thr?.id) {
					ensureThread(thr.id);
					// Sub-agent threads belong to their spawning session, not the
					// session rail.
					if (isSubAgentThread(thr)) mergeAgentThreadMeta(agents, thr);
					else upsertSession(thr);
				}
				break;
			}
			case 'thread/archived': {
				if (tid) removeSession(tid);
				break;
			}
			case 'thread/closed': {
				if (tid) removeSession(tid);
				break;
			}
			case 'thread/unarchived': {
				if (p.thread) upsertSession(p.thread);
				else void loadSessions();
				break;
			}
			case 'thread/deleted': {
				if (tid) {
					removeSession(tid);
					archivedSessions = archivedSessions.filter((session) => session.id !== tid);
				}
				break;
			}
			case 'thread/name/updated': {
				if (tid && typeof p.name === 'string') {
					sessions = sessions.map((session) => session.id === tid ? { ...session, name: p.name } : session);
				}
				break;
			}
			case 'turn/started': {
				if (tid) {
					scheduleTaskUsageRefresh(tid);
					if (!turnModels[tid] && sessionConfigs[tid]?.model) {
						turnModels = { ...turnModels, [tid]: sessionConfigs[tid].model };
					}
					if (!turnEfforts[tid] && sessionConfigs[tid]?.effort) {
						turnEfforts = { ...turnEfforts, [tid]: sessionConfigs[tid].effort };
					}
					markTaskStarted(tid);
					const t = ensureThread(tid);
					t.status = 'running';
					t.turnStartedAt = typeof p.turn?.startedAt === 'string' ? Date.parse(p.turn.startedAt) : Date.now();
					if (!Number.isFinite(t.turnStartedAt)) t.turnStartedAt = Date.now();
				t.turnId = p.turn?.id ?? null;
				if (p.turn?.id) activeTurnBySession[tid] = p.turn.id;
					t.error = null;
					touchSession(tid, p.turn?.startedAt);
				}
				break;
			}
			case 'turn/completed': {
				if (tid) scheduleTaskUsageRefresh(tid);
				const completedTurnId = typeof p.turn?.id === 'string' ? p.turn.id : null;
				const currentTurnId = tid ? threads[tid]?.turnId : null;
				if (tid && !(completedTurnId && currentTurnId && completedTurnId !== currentTurnId)) {
					setTimeout(() => {
						delete restartPromptEchoes[tid];
						delete suppressedRestartItemIds[tid];
					}, 60_000);
					if (turnModels[tid]) {
						const { [tid]: _finishedTurnModel, ...remainingTurnModels } = turnModels;
						turnModels = remainingTurnModels;
					}
					if (turnEfforts[tid]) {
						const { [tid]: _finishedTurnEffort, ...remainingTurnEfforts } = turnEfforts;
						turnEfforts = remainingTurnEfforts;
					}
					markTaskCompleted(tid);
					const t = ensureThread(tid);
					t.status = 'idle';
					const duration = t.turnStartedAt === null ? null : Math.max(0, Date.now() - t.turnStartedAt);
					t.turnStartedAt = null;
					t.turnId = null;
				delete activeTurnBySession[tid];
				if (p.turn?.status === 'completed') {
					for (const itemId of t.order) {
						const item = t.byId[itemId] as any;
						if (item?.type === 'agentMessage' && !item._completed) {
							t.byId[itemId] = { ...item, _completed: true };
						}
					}
				}
				touchSession(tid, p.turn?.completedAt);
					if (p.turn?.status === 'failed' && p.turn?.error?.message) {
						t.error = p.turn.error.message;
					}
					if (duration !== null) stampTurnDuration(tid, duration);
					void refreshFileChangeLineStats(tid);
					if (tid === activeId) filesRefresh += 1;
					advanceTodoQueue(tid);
					if (p.turn?.status === 'completed') {
						const sessionId = agents[tid] ? agentRootId(agents, agents[tid]) : tid;
						if (threads[sessionId]?.status === 'idle') markSessionFinished(sessionId);
					}
				}
				break;
			}
			case 'item/started':
			case 'item/completed': {
				if (tid && p.item?.id) {
					if (p.item.type === 'userMessage' && suppressRestartPromptEcho(tid, p.item, msg.method === 'item/completed')) break;
					if (msg.method === 'item/completed' && p.item.type === 'agentMessage' && dismissedAttentionByThread[tid]) {
						const { [tid]: _read, ...remainingAttention } = dismissedAttentionByThread;
						dismissedAttentionByThread = remainingAttention;
						localStorage.setItem(DISMISSED_ATTENTION_KEY, JSON.stringify(remainingAttention));
					}
					if (p.item.type === 'userMessage') dropEchoedUserMessage(tid, p.item);
					upsertItem(tid, p.item, true, p.turnId, msg.method === 'item/completed' && p.item.type === 'agentMessage');
				}
				// The file browser refreshes what it is showing when the agent
				// touches files in the viewed session.
				if (tid === activeId && p.item?.type === 'fileChange') filesRefresh += 1;
				break;
			}
			case 'turn/diff/updated': {
				if (tid === activeId) filesRefresh += 1;
				break;
			}
			case 'item/agentMessage/delta': {
				if (tid && p.itemId) {
					const t = ensureThread(tid);
					const it = t.byId[p.itemId] as any;
					if (it) it.text = visibleAgentMessageText((it.text ?? '') + (p.delta ?? ''));
				}
				break;
			}
			case 'item/reasoning/summaryTextDelta': {
				if (tid && p.itemId) {
					const t = ensureThread(tid);
					const it = t.byId[p.itemId] as any;
					if (it) it._reason = (it._reason ?? '') + (p.delta ?? '');
				}
				break;
			}
			case 'item/commandExecution/outputDelta': {
				if (tid && p.itemId) {
					const t = ensureThread(tid);
					const it = t.byId[p.itemId] as any;
					if (it) it._out = (it._out ?? '') + (p.delta ?? '');
				}
				break;
			}
			case 'thread/tokenUsage/updated': {
				if (tid) {
					const t = ensureThread(tid);
					const statistics = reportedTokenStatistics(p.tokenUsage);
					if (statistics) t.tokenStatistics = statistics;
					const tokens = currentContextTokens(p.tokenUsage);
					if (tokens !== null) t.tokens = tokens;
					t.contextWindow = p.tokenUsage?.modelContextWindow ?? t.contextWindow;
				}
				break;
			}
			case 'thread/goal/updated': {
				if (tid && p.goal) ensureThread(tid).goal = p.goal as Goal;
				break;
			}
			case 'thread/goal/cleared': {
				if (tid) ensureThread(tid).goal = null;
				break;
			}
			case 'thread/settings/updated': {
				if (tid && p.threadSettings) {
					setFastSession(tid, p.threadSettings.serviceTier === 'priority');
				}
				break;
			}
			case 'turn/error':
			case 'error': {
				if (tid) {
					const t = ensureThread(tid);
					t.error = p.error?.message ?? 'error';
					t.status = 'idle';
				}
				break;
			}
		}

		if (shouldScroll) {
			scrollToBottom();
		} else if (
			affectedThreadId === viewedId &&
			(msg.method.startsWith('item/') || msg.method.startsWith('turn/'))
		) {
			unseenActivity = true;
		}
	}

	function isTranscriptAtBottom(): boolean {
		if (!transcriptEl) return true;
		const remaining = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
		return remaining <= 24;
	}

	let bottomJumpGeneration = 0;
	function cancelBottomJump() { bottomJumpGeneration++; }
	function cancelJumpOnInput(node: HTMLElement) {
		const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
		for (const event of events) node.addEventListener(event, cancelBottomJump, { passive: true });
		return { destroy() { for (const event of events) node.removeEventListener(event, cancelBottomJump); } };
	}
	async function scrollToBottom() {
		const generation = ++bottomJumpGeneration;
		const targetId = viewedId;
		await tick();
		if (!transcriptEl || generation !== bottomJumpGeneration || targetId !== viewedId) return;
		const viewport = transcriptEl;
		unseenActivity = false;
		await settleTranscriptBottom(viewport, {
			flush: tick,
			frame: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
			update: updateTranscriptViewport,
			cancelled: () => generation !== bottomJumpGeneration || targetId !== viewedId || viewport !== transcriptEl,
			atEnd: () => virtualTranscript.after === 0
		});
	}

	function transcriptRowKey(item: ThreadItem): string {
		return `${viewedId ?? 'none'}:${(item as any).id ?? ''}`;
	}

	function measuredRowHeight(item: ThreadItem): number {
		return rowHeights.get(transcriptRowKey(item)) ?? ESTIMATED_ROW_HEIGHT;
	}

	function virtualizeItems(
		items: ThreadItem[],
		scrollTop: number,
		viewportHeight: number,
		_heightVersion: number
	): { items: ThreadItem[]; before: number; after: number; total: number } {
		if (items.length === 0) return { items: [], before: 0, after: 0, total: 0 };

		const startOffset = Math.max(0, scrollTop - VIRTUAL_OVERSCAN_PX);
		const endOffset = scrollTop + viewportHeight + VIRTUAL_OVERSCAN_PX;
		let before = 0;
		let start = 0;

		while (start < items.length) {
			const h = measuredRowHeight(items[start]);
			if (before + h >= startOffset) break;
			before += h;
			start += 1;
		}

		let renderedHeight = 0;
		let end = start;
		while (end < items.length) {
			const h = measuredRowHeight(items[end]);
			renderedHeight += h;
			end += 1;
			if (before + renderedHeight > endOffset) break;
		}

		let after = 0;
		for (let i = end; i < items.length; i += 1) after += measuredRowHeight(items[i]);
		return { items: items.slice(start, end), before, after, total: before + renderedHeight + after };
	}

	function updateTranscriptViewport() {
		if (!transcriptEl) {
			transcriptViewportHeight = 0;
			transcriptScrollTop = 0;
			showBottomJump = false;
			return;
		}
		transcriptViewportHeight = transcriptEl.clientHeight;
		transcriptScrollTop = transcriptEl.scrollTop;
		showBottomJump = !isTranscriptAtBottom();
	}

	function onTranscriptScroll() {
		updateTranscriptViewport();
		if (isTranscriptAtBottom()) unseenActivity = false;
	}

	function jumpToTranscriptPoint(index: number) {
		cancelBottomJump();
		if (!transcriptEl) return;
		let offset = 0;
		for (let i = 0; i < index && i < displayedItems.length; i += 1) {
			offset += measuredRowHeight(displayedItems[i]);
		}
		transcriptEl.scrollTop = offset;
		updateTranscriptViewport();
	}

	function measureTranscriptRow(node: HTMLElement, key: string) {
		const measure = () => {
			const next = node.getBoundingClientRect().height;
			if (next <= 0) return;
			const prev = rowHeights.get(key);
			if (prev === undefined || Math.abs(prev - next) > 0.5) {
				rowHeights.set(key, next);
				transcriptHeightVersion += 1;
			}
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return {
			update(nextKey: string) {
				key = nextKey;
				measure();
			},
			destroy() {
				observer.disconnect();
			}
		};
	}

	async function loadSessions() {
		try {
			const res = await fetch('/api/threads');
			const data = await res.json();
			const fetched: ThreadSummary[] = data.data ?? [];
			// Merge instead of replacing: sessions created or forked after this
			// fetch started (and not yet visible to thread/list) must survive.
			const extras = sessions.filter((s) => !fetched.some((f) => f.id === s.id));
			sessions = [...extras, ...fetched];
			defaultCwd = data.defaultCwd ?? '';
			await recoverSideChats();
		} finally {
			sessionsLoaded = true;
		}
	}

	// Codex may not index a new thread until its first prompt. Remember routing
	// only; recovery must still verify that Codex has the thread loaded.
	function emptySessionHosts(): Record<string, string> {
		try {
			const value = JSON.parse(localStorage.getItem(EMPTY_SESSION_HOSTS_KEY) ?? '{}');
			return value && typeof value === 'object' && !Array.isArray(value)
				? Object.fromEntries(Object.entries(value).filter(([, host]) => typeof host === 'string')) as Record<string, string> : {};
		} catch { return {}; }
	}

	function rememberEmptySession(id: string, host: string | null) {
		const saved = emptySessionHosts();
		if (host === null) delete saved[id];
		else saved[id] = host;
		try { localStorage.setItem(EMPTY_SESSION_HOSTS_KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ }
	}

	// Ephemeral side chats are never persisted, so thread/list omits them.
	// Re-attach any still loaded in codex memory to their parent sessions.
	// Codex only reports forkedFromId in the thread/fork response, so the
	// parent link is bridged through sessionStorage (same lifetime as the
	// ephemeral thread: this browser session). The same sweep re-discovers
	// sub-agent threads still loaded from a running collaboration turn —
	// thread/list defaults to interactive sources and omits them too.
	async function recoverSideChats() {
		try {
			const emptyHosts = emptySessionHosts();
			// Also recover an empty replacement created before this fix when its
			// URL is still open. Never recreate a thread or send a dummy prompt.
			if (activeId) emptyHosts[activeId] ??= activeHost;
			const res = await fetch('/api/threads/loaded');
			const data = await res.json();
			const loaded: string[] = data.data ?? [];
			const missing = loaded.filter(
				(id) => !sessions.some((s) => s.id === id) && !agents[id]
			);
			for (const id of missing) {
				try {
					const host = emptyHosts[id];
					const res = await fetch(`/api/threads/${id}${host ? hostQuery(host) : ''}`);
					const data = await res.json();
					const thr = data.thread;
					if (isSubAgentThread(thr)) {
						mergeAgentThreadMeta(agents, thr);
						continue;
					}
					const parentId = thr?.id ? sessionStorage.getItem(sideParentKey(thr.id)) : null;
					if (thr?.ephemeral && parentId) {
						upsertSession({ ...thr, forkedFromId: thr.forkedFromId ?? parentId ?? null });
					} else if (thr?.id && !thr.ephemeral && host) {
						upsertSession({ ...thr, host });
						rememberEmptySession(id, host);
					}
				} catch {
					/* unreadable thread — skip */
				}
			}
		} catch {
			/* loaded list unavailable — skip recovery */
		}
	}

	async function startCreating() {
		createError = null;
		newCwd = '';
		cwdBrowseOpen = false;
		cwdBrowsePath = '';
		cwdBrowseEntries = [];
		showHiddenDirectories = false;
		cwdBrowseError = null;
		newProfile = '';
		newMachine = LOCAL_HOST;
		newProvider = 'codex';
		creating = true;
		// Hosts come from ~/.ssh/config, re-read by the backend on demand.
		void loadHostChoices();
		// The create form lives in the session rail; surface it if it's hidden
		// (welcome-screen CTA on mobile, or desktop with the rail collapsed).
		if (mobileViewport) {
			mobileSidebarOpen = true;
		} else if (desktopSidebarHidden) {
			desktopSidebarHidden = false;
			localStorage.setItem('yacwu-sidebar-hidden', 'false');
		}
		// Always re-fetch: the backend reads profile files fresh from disk.
		void loadProfileChoices(LOCAL_HOST);
		await tick();
		cwdInputEl?.focus();
	}

	function cancelCreating() {
		creating = false;
		createError = null;
	}

	async function openSidebar() {
		mobileSidebarOpen = true;
		await tick();
		const target =
			sidebarEl?.querySelector<HTMLElement>('.session.active') ??
			sidebarEl?.querySelector<HTMLElement>('.new') ??
			sidebarEl?.querySelector<HTMLElement>('a, button:not(:disabled)');
		target?.focus();
	}

	async function closeSidebar(restoreFocus = true) {
		mobileSidebarOpen = false;
		await tick();
		if (restoreFocus) sidebarToggleEl?.focus();
	}

	async function toggleSidebar() {
		if (mobileViewport) {
			if (mobileSidebarOpen) await closeSidebar();
			else await openSidebar();
			return;
		}
		desktopSidebarHidden = !desktopSidebarHidden;
		localStorage.setItem('yacwu-sidebar-hidden', desktopSidebarHidden ? 'true' : 'false');
		await tick();
		if (desktopSidebarHidden) sidebarToggleEl?.focus();
		else sidebarEl?.querySelector<HTMLElement>('.drawer-close')?.focus();
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (!mobileViewport || !mobileSidebarOpen) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			void closeSidebar();
			return;
		}
		if (event.key === 'Tab') {
			const focusable = Array.from(
				sidebarEl?.querySelectorAll<HTMLElement>(
					'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
				) ?? []
			).filter((element) => element.getClientRects().length > 0);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	}

	/**
	 * Connect to a remote host and pull its sessions into the rail (plus its
	 * default working directory for the create form). Triggered by picking a
	 * host — the connection may take a few seconds while ssh bootstraps the
	 * remote app-server; state updates arrive over the event stream.
	 */
	async function loadHostSessions(host: string) {
		try {
			const res = await fetch(`/api/threads${hostQuery(host)}`);
			const data = await res.json();
			if (!res.ok) {
				if (newHost === host) createError = data.error ?? `could not reach ${host}`;
				return;
			}
			if (newHost === host) createError = null;
			hostDefaultCwds[host] = data.defaultCwd ?? '';
			const fetched: ThreadSummary[] = data.data ?? [];
			const others = sessions.filter((s) => !fetched.some((f) => f.id === s.id));
			sessions = [...others, ...fetched];
		} catch {
			if (newHost === host) createError = `could not reach ${host}`;
		}
	}

	/** Profiles live on the session's machine; re-fetch when the host changes. */
	async function loadProfileChoices(host: string) {
		profileChoices = [];
		try {
			const res = await fetch(`/api/profiles${hostQuery(host)}`);
			const data = await res.json();
			if (newHost === host) profileChoices = (data.profiles ?? []) as ProfileChoice[];
		} catch {
			if (newHost === host) profileChoices = [];
		}
	}

	function onNewHostChange() {
		if (newMachine !== LOCAL_HOST) newProvider = 'codex';
		cwdBrowseRequest++;
		cwdBrowseLoading = false;
		createError = null;
		newProfile = '';
		cwdBrowseOpen = false;
		cwdBrowsePath = '';
		void loadProfileChoices(newHost);
		if (isRemoteHost(newHost) && hostDefaultCwds[newHost] === undefined) {
			void loadHostSessions(newHost);
		}
	}

	function directoryParent(path: string): string {
		const normalized = path.replace(/[\\/]+$/, '');
		const slash = normalized.lastIndexOf('/');
		if (slash <= 0) return normalized.startsWith('/') ? '/' : normalized;
		return normalized.slice(0, slash);
	}

	async function browseDirectories(path?: string) {
		const request = ++cwdBrowseRequest;
		const host = newHost;
		cwdBrowseOpen = true;
		cwdBrowseLoading = true;
		cwdBrowseError = null;
		try {
			const params = new URLSearchParams();
			if (isRemoteHost(newHost)) params.set('host', newHost);
			const requested = path ?? (newCwd.trim() || (isRemoteHost(newHost) ? hostDefaultCwds[newHost] : defaultCwd));
			if (requested) params.set('path', requested);
			const res = await fetch(`/api/directories?${params.toString()}`);
			const data = await res.json();
			if (request !== cwdBrowseRequest || host !== newHost) return;
			if (!res.ok) throw new Error(data.error ?? 'Could not list this directory');
			cwdBrowsePath = data.path ?? '';
			// Browsing into a folder selects it too; starting a session must not
			// silently use the old/default folder shown before navigation.
			if (cwdBrowsePath) newCwd = cwdBrowsePath;
			cwdBrowseEntries = (data.entries ?? []).filter((entry: DirectoryChoice) => entry.kind === 'dir');
		} catch (error) {
			if (request !== cwdBrowseRequest || host !== newHost) return;
			cwdBrowseError = error instanceof Error ? error.message : 'Could not list this directory';
			cwdBrowseEntries = [];
		} finally {
			if (request === cwdBrowseRequest) cwdBrowseLoading = false;
		}
	}

	function selectBrowseDirectory(path = cwdBrowsePath) {
		newCwd = path;
		cwdBrowseOpen = false;
		cwdInputEl?.focus();
	}

	async function newSession(cwd?: string) {
		createError = null;
		if (cwdBrowseLoading) {
			createError = 'Wait for the selected folder to finish loading.';
			return;
		}
		const profile = newProfile.trim();
		const host = newHost;
		const remote = isRemoteHost(host);
		const res = await fetch('/api/threads', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				...(cwd ? { cwd } : {}),
				...(profile ? { profile } : {}),
				...(remote ? { host } : {})
			})
		});
		const data = await res.json();
		if (!res.ok) {
			createError = data.error ?? 'failed to create session';
			return;
		}
		creating = false;
		const id = data.thread?.id;
		if (id) {
			rememberEmptySession(id, data.host ?? host);
			const thread = ensureThread(id);
			thread.status = data.thread?.status?.type === 'active' ? 'running' : 'idle';
			// thread/start already gave us an empty transcript. Avoid immediately
			// calling thread/read + thread/resume, which fails on Codex builds where
			// the new rollout has no history yet.
			sessionHistoryLoaded[id] = true;
			upsertSession({ ...data.thread, host: data.host ?? host });
			setFastSession(id, data.serviceTier === 'priority');
			goto(`/s/${id}${hostQuery(data.host ?? host)}`);
			mobileSidebarOpen = false;
		}
	}

	// Open the session named in the URL whenever it changes. Only the URL id is a
	// reactive dependency; the rest runs untracked so item updates don't re-trigger.
	$effect(() => {
		const id = page.params.id ?? null;
		untrack(() => {
			conflict = null;
			unseenActivity = false;
			if (!id) return;
			clearFinishedSession(id);
			markSessionAttentionRead(id);
			// Stale browsing state must not leak across visits to a session.
			composerHistories.get(id)?.resetNavigation();
			slashDismissedToken = null;
			void loadSessionConfig(id);
			ensureThread(id);
			if (sessionHistoryLoaded[id] || sessionOpening[id]) {
				scrollToBottom();
				return;
			}
			openSession(id, false);
		});
	});

	$effect(() => {
		const id = activeId;
		const host = activeHost;
		if (!id) return;
		untrack(() => void loadAccountUsage(host));
	});

	async function loadSessionConfig(id: string) {
		const previous = sessionConfigs[id];
		const [modelResult, profileResult] = await Promise.allSettled([
			fetch(threadApi(id, '/model')).then(async (res) => {
				if (!res.ok) throw new Error('model settings unavailable');
				return (await res.json()) as ModelState;
			}),
			fetch(threadApi(id, '/profile')).then(async (res) => {
				if (!res.ok) throw new Error('profile unavailable');
				return (await res.json()) as { profile?: string | null };
			})
		]);
		const model = modelResult.status === 'fulfilled' ? modelResult.value : null;
		if (model) rememberEfforts(id, model);
		const profile = profileResult.status === 'fulfilled' ? profileResult.value.profile ?? null : previous?.profile ?? null;
		if (!model && !previous) return;
		sessionConfigs[id] = {
			model: model?.model ?? previous.model,
			effort: model?.effort ?? previous.effort,
			profile
		};
	}

	/** Cache the catalog and reasoning efforts the session's current model accepts. */
	function rememberEfforts(id: string, settings: ModelState) {
		sessionModels[id] = settings.models;
		const choice = settings.models.find((m) => m.id === settings.model);
		modelEfforts[id] = choice?.efforts ?? [];
	}

	function effortLabel(effort: string): string {
		return effort.charAt(0).toUpperCase() + effort.slice(1);
	}

	function captureTurnModelBeforeConfigChange(id: string) {
		if ((threads[id]?.turnId || activeTurnBySession[id]) && !turnModels[id] && sessionConfigs[id]?.model) {
			turnModels = { ...turnModels, [id]: sessionConfigs[id].model };
		}
		if ((threads[id]?.turnId || activeTurnBySession[id]) && !turnEfforts[id] && sessionConfigs[id]?.effort) {
			turnEfforts = { ...turnEfforts, [id]: sessionConfigs[id].effort };
		}
	}

	async function applySuggestedSettings(model: string, effort: string) {
		const id = activeId;
		if (!id || modelPending || effortPending || switchingPromptModel) return;
		captureTurnModelBeforeConfigChange(id);
		modelPending = true;
		try {
			const { ok, data } = await postCmd(id, 'model', { model, ...(effort ? { effort } : {}) });
			if (!ok) { addLocalNote(id, data.error ?? 'failed to apply suggested settings', 'err'); return; }
			const settings = data as ModelState;
			sessionConfigs[id] = { model: settings.model, effort: settings.effort, profile: sessionConfigs[id]?.profile ?? null };
			rememberEfforts(id, settings);
		} catch {
			addLocalNote(id, 'failed to apply suggested settings', 'err');
		} finally { modelPending = false; }
	}

	/** Composer model picker: the server preserves a compatible effort or uses the model default. */
	async function setComposerModel(select: HTMLSelectElement) {
		const id = activeId;
		const current = id ? sessionConfigs[id]?.model : null;
		const model = select.value;
		if (!id || !current || model === current) return;
		captureTurnModelBeforeConfigChange(id);
		modelPending = true;
		try {
			const { ok, data } = await postCmd(id, 'model', { model });
			if (ok) {
				const settings = data as ModelState;
				sessionConfigs[id] = {
					model: settings.model,
					effort: settings.effort,
					profile: sessionConfigs[id]?.profile ?? null
				};
				rememberEfforts(id, settings);
			} else {
				select.value = current;
				addLocalNote(id, data.error ?? 'failed to change model', 'err');
			}
		} finally {
			modelPending = false;
		}
	}

	/** Composer effort picker: same thread /model call as `/model --effort`. */
	async function setComposerEffort(select: HTMLSelectElement) {
		const id = activeId;
		const current = id ? sessionConfigs[id]?.effort : null;
		const effort = select.value;
		if (!id || !current || effort === current) return;
		captureTurnModelBeforeConfigChange(id);
		effortPending = true;
		try {
			const { ok, data } = await postCmd(id, 'model', { effort });
			if (ok) {
				const settings = data as ModelState;
				sessionConfigs[id] = {
					model: settings.model,
					effort: settings.effort,
					profile: sessionConfigs[id]?.profile ?? null
				};
				rememberEfforts(id, settings);
			} else {
				select.value = current;
				addLocalNote(id, data.error ?? 'failed to change reasoning effort', 'err');
			}
		} finally {
			effortPending = false;
		}
	}

	/** Delivery records and the server-side setting for one session. */
	async function loadRelayLog(id: string) {
		const requestSeq = ++relaySeq;
		try {
			const res = await fetch(`/api/threads/${encodeURIComponent(id)}/relay`);
			if (!res.ok) return;
			const data = await res.json();
			relayStore = applyRelaySnapshot(relayStore, { epoch: data.epoch, messages: data.messages ?? [] }, requestSeq, ++relaySeq);
			relayEnabled = { ...relayEnabled, [id]: data.enabled !== false };
		} catch {
			/* Attribution falls back to showing text as written. */
		}
	}

	async function setRelayEnabled(id: string, enabled: boolean): Promise<boolean> {
		try {
			const res = await fetch(`/api/threads/${encodeURIComponent(id)}/relay/settings`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled })
			});
			if (!res.ok) return false;
			const data = await res.json();
			relayEnabled = { ...relayEnabled, [id]: data.enabled !== false };
			return true;
		} catch {
			return false;
		}
	}

	/** Show a relayed message's progress in the sender's and recipient's transcripts. */
	function noteRelayRecord(record: RelayRecord) {
		for (const [threadId, direction] of [[record.to.thread, 'in'], [record.from.thread, 'out']] as const) {
			if (!threads[threadId]) continue;
			upsertItem(threadId, { type: 'relayNotice', id: `relay-${direction}-${record.id}`, direction, record } as any, true);
		}
	}

	async function openSession(id: string, force: boolean) {
		if (sessionHistoryLoaded[id] || sessionOpening[id]) return;
		sessionOpening[id] = true;
		void loadRelayLog(id);
		try {
			const res = await fetch(threadApi(id, '/open'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ force })
			});
			const data = await res.json();
			if (res.status === 409 && data.conflict) {
				conflict = { id, holders: data.holders ?? [] };
				return;
			}
			if (!res.ok) throw new Error(data.error ?? `Could not load session history (${res.status})`);
			conflict = null;
			const thr = data.thread;
			if (thr?.cwd) cwds[id] = thr.cwd;
			if ('serviceTier' in data) setFastSession(id, data.serviceTier === 'priority');
			const runtimeStatus = thr?.status?.type;
			const wasRunning = Object.values(runningTasks).includes(id);
			if (thr) syncThreadRuntime(id, thr);
			if (runtimeStatus === 'notLoaded' && wasRunning) {
				interruptedSessions[id] = true;
				delete recoveringSessions[id];
				persistInterruptedSessions();
			}
			// Only sync the transcript when the server actually returned history.
			// A failed open (e.g. a brand-new thread with no rollout yet) must not
			// wipe locally rendered items — the response can arrive late, after
			// the user has already run slash commands in this session.
			if (thr) {
				// Notifications may arrive before thread/read returns. Load the saved
				// rollout first, then merge those live items back so history is not
				// replaced by a partial stream snapshot.
				const liveItems = itemsOf(ensureThread(id));
				replaceItems(id, thr.turns ?? []);
				for (const item of liveItems) upsertItem(id, item as ThreadItem & { id: string });
			}
			sessionHistoryLoaded[id] = true;
			reconcileTodoQueue(id, runtimeStatus);
			// Surface any persisted goal for this session.
			fetch(threadApi(id, '/goal'))
				.then((r) => r.json())
				.then((g) => {
					ensureThread(id).goal = (g?.goal ?? null) as Goal | null;
				})
				.catch(() => {});
		} catch (error) {
			addLocalNote(id, error instanceof Error ? error.message : 'Could not load session history', 'err');
		} finally {
			delete sessionOpening[id];
			scrollToBottom();
		}
	}

	function forceOpen() {
		if (conflict) openSession(conflict.id, true);
	}

	function dismissConflict() {
		conflict = null;
		goto('/');
	}

	// -- Sub-agent transcripts -------------------------------------------------

	/** Agent-thread API URL. Agents run on their parent session's host. */
	function agentApi(agentId: string, params: Record<string, string> = {}): string {
		const query = new URLSearchParams(params);
		const host = sessionHost(activeId);
		if (isRemoteHost(host)) query.set('host', host);
		const qs = query.toString();
		return `/api/threads/${agentId}${qs ? `?${qs}` : ''}`;
	}

	/** The /s/<session> URL with the agent selection set or cleared. */
	function agentHref(agentId: string | null): string {
		const params = new URLSearchParams(page.url.search);
		if (agentId) params.set('agent', agentId);
		else params.delete('agent');
		const qs = params.toString();
		return `/s/${activeId}${qs ? `?${qs}` : ''}`;
	}

	/** Select an agent's transcript; selecting it again returns to the session. */
	function toggleAgent(agentId: string) {
		goto(agentHref(viewedAgentId === agentId ? null : agentId));
	}

	/**
	 * Seed a selected agent's transcript from thread/read. Live events for the
	 * thread already stream over /api/events; this backfills what happened
	 * before the page (or the selection) existed. Read-only on purpose: the
	 * parent turn owns collab agent threads, so they are never resumed here.
	 */
	async function loadAgentTranscript(agentId: string) {
		agentHistoryLoading = true;
		try {
			const res = await fetch(agentApi(agentId, { turns: '1' }));
			const data = await res.json();
			if (res.ok && data.thread) {
				if (Array.isArray(data.thread.turns) && data.thread.turns.length > 0) {
					replaceItems(agentId, data.thread.turns);
				}
				mergeAgentThreadMeta(agents, data.thread, activeId ?? undefined);
			}
		} catch {
			/* keep whatever streamed in live */
		} finally {
			agentHistoryLoading = false;
			scrollToBottom();
		}
	}

	/** Fill in nickname/role for agents discovered through collab items only. */
	async function loadAgentMeta(agentId: string) {
		try {
			const res = await fetch(agentApi(agentId));
			const data = await res.json();
			if (res.ok && data.thread) mergeAgentThreadMeta(agents, data.thread);
		} catch {
			/* label falls back to the agent path or thread id */
		}
	}

	// Viewing an agent (including via a pasted URL) registers it and seeds its
	// transcript once. Only the selection is a reactive dependency.
	$effect(() => {
		const id = viewedId;
		untrack(() => { if (id) void scrollToBottom(); });
	});

	$effect(() => {
		const agentId = viewedAgentId;
		const sessionId = activeId;
		untrack(() => {
			if (!agentId || !sessionId) return;
			if (!agents[agentId]) mergeAgentThreadMeta(agents, { id: agentId }, sessionId);
			if (ensureThread(agentId).order.length === 0) void loadAgentTranscript(agentId);
			else scrollToBottom();
		});
	});

	// Agents surfaced by collab items carry no nickname/role; read each such
	// thread's metadata once so header buttons get their proper labels.
	$effect(() => {
		const pending = activeAgents.filter(
			(agent) => !agent.nickname && !agentMetaFetched.has(agent.id)
		);
		if (pending.length === 0) return;
		untrack(() => {
			for (const agent of pending) {
				agentMetaFetched.add(agent.id);
				void loadAgentMeta(agent.id);
			}
		});
	});

	function agentIsRunning(agent: AgentInfo): boolean {
		return isAgentRunning(agent, threads[agent.id]?.status);
	}

	function agentStateLabel(agent: AgentInfo): string {
		if (agentIsRunning(agent)) return 'running';
		if (agent.closed) return 'closed';
		return agent.state ?? 'idle';
	}

	function agentTitle(agent: AgentInfo): string {
		const role = agent.role ? ` [${agent.role}]` : '';
		return `Agent ${agentLabel(agent)}${role} · ${agentStateLabel(agent)} · ${agent.id.slice(0, 8)}`;
	}

	function isFailedFetch(err: unknown): boolean {
		return err instanceof TypeError && err.message === 'Failed to fetch';
	}

	function retryDelay(attempt: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
	}

	async function sendMessageRequest(id: string, text: string, attachments: SelectedAttachment[], turnId: string | null): Promise<Response> {
		const rules = rulesFor(id);
		const ruleText = withSessionRules(rules.sharedChannel ? await addSharedChannelContext(id, text) : visibleUserText(text), rules);
		// Only Yacwu's Claude backend sends progress reminders; tell it how often.
		const reminders = isClaudeSession(id) ? (settings.claudeProgressReminders ? settings.claudeReminderMinutes : null) : undefined;
		const messageText = rules.progress ? withTaskProgressInstructions(ruleText, reminders) : ruleText;
		if (attachments.length > 0) {
			const body = new FormData();
			body.set('text', messageText);
			if (turnId) body.set('turnId', turnId);
			for (const attachment of attachments) {
				body.append(attachment.kind === 'image' ? 'images' : 'files', attachment.file, attachment.name);
			}
			return fetch(threadApi(id, '/message'), { method: 'POST', body });
		}

		return fetch(threadApi(id, '/message'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text: messageText, ...(turnId ? { turnId } : {}) })
		});
	}

	async function sendMessageWithRetries(id: string, text: string, attachments: SelectedAttachment[], turnId: string | null = null): Promise<Response> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await sendMessageRequest(id, text, attachments, turnId);
			} catch (err) {
				if (!isFailedFetch(err) || attempt >= SEND_FETCH_RETRIES) throw err;
				await retryDelay(attempt);
			}
		}
	}

	function retryLastPrompt() {
		if (!activeId || viewedAgentId || sendingMessage) return;
		const lastUserMessage = [...itemsOf(viewed)].reverse().find((item) => item.type === 'userMessage') as any;
		const text = (lastUserMessage?.content ?? [])
			.map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
			.join('')
			.trim();
		if (!text) return;
		input = text;
		void send();
	}

	async function send(interactiveQuestion?: { id: string; threadId: string }) {
		if (sendingMessage || clearingSessionId) return;
		const draftInput = input;
		const draftAttachments = selectedAttachments;
		const text = draftInput.trim();
		if ((!text && selectedAttachments.length === 0) || !activeId) return;
		const id = activeId;

		// Slash commands are handled client-side and dispatched to dedicated RPCs,
		// mirroring the Codex TUI. Everything else is a normal model turn.
		if (text.startsWith('/') && draftAttachments.length === 0) {
			input = '';
			promptDrafts[id] = '';
			composerHistoryOf(id).record(text);
			await handleSlash(id, text);
			return;
		}

		const t = ensureThread(id);
		t.status = 'running';
		t.error = null;
		sendingMessage = true;
		const echoId = addLocalUserMessage(id, text, draftAttachments);
		try {
			const res = await sendMessageWithRetries(id, text, draftAttachments, t.status === 'running' ? t.turnId : null);

			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error ?? `failed to send message (${res.status})`);
			}
			if (interactiveQuestion) {
				resolveInteractiveQuestion(interactiveQuestion);
				addLocalNote(id, 'Answer accepted by Codex; waiting for the agent to respond.');
			}

			if (input === draftInput) input = '';
			if (input === '') promptDrafts[id] = '';
			if (selectedAttachments === draftAttachments) {
				for (const attachment of draftAttachments) {
					if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
				}
				selectedAttachments = [];
			}
			composerHistoryOf(id).record(text);
		} catch (err) {
			t.status = 'idle';
			removeLocalItem(id, echoId);
			addLocalNote(id, err instanceof Error ? err.message : 'failed to send message', 'err');
		} finally {
			sendingMessage = false;
		}
	}

	function answerInteractiveChoice(option: string) {
		if (!pendingInteractiveChoice || sendingMessage || !option.trim()) return;
		retainPendingInteractiveQuestions();
		input = `I choose: ${option}`;
		void send(pendingInteractiveChoice);
	}

	function resolveInteractiveQuestion(question: { id: string; threadId: string }) {
		resolvedInteractiveQuestionIds = {
			...resolvedInteractiveQuestionIds,
			[`${question.threadId}:${question.id}`]: true
		};
		try { localStorage.setItem(RESOLVED_QUESTIONS_KEY, JSON.stringify(resolvedInteractiveQuestionIds)); } catch { /* Keep the in-memory dismissal when storage is unavailable. */ }
	}

	function dismissInteractiveChoice() {
		if (pendingInteractiveChoice) {
			retainPendingInteractiveQuestions();
			resolveInteractiveQuestion(pendingInteractiveChoice);
		}
		interactiveChoiceDialog?.close();
	}

	function retainPendingInteractiveQuestions() {
		const retained = new Map<string, (typeof pendingInteractiveQuestions)[number]>();
		for (const item of [...retainedInteractiveQuestions, ...pendingInteractiveQuestions]) retained.set(`${item.threadId}:${item.id}`, item);
		retainedInteractiveQuestions = [...retained.values()];
	}

	function fmtDuration(sec: number): string {
		const d = Math.floor(sec / 86400);
		const h = Math.floor((sec % 86400) / 3600);
		const m = Math.floor((sec % 3600) / 60);
		if (d) return `${d}d ${h}h`;
		if (h) return `${h}h ${m}m`;
		if (m) return `${m}m`;
		return `${Math.max(0, sec)}s`;
	}

	function sessionTimestampDate(timestamp: number | null | undefined): Date | null {
		if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
		const date = new Date(timestamp * 1000);
		return Number.isNaN(date.getTime()) ? null : date;
	}

	function fmtSessionTimestamp(timestamp: number | null | undefined): string {
		const date = sessionTimestampDate(timestamp);
		if (!date) return '—';
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(date);
	}

	function sessionTimestampIso(timestamp: number | null | undefined): string | undefined {
		return sessionTimestampDate(timestamp)?.toISOString();
	}

	function fmtReset(resetsAt: number): string {
		const diff = resetsAt - Math.floor(Date.now() / 1000);
		const countdown = diff <= 0 ? 'now' : fmtDuration(diff);
		const date = new Date(resetsAt * 1000);
		if (!Number.isFinite(date.getTime())) return countdown;
		const timestamp = new Intl.DateTimeFormat(undefined, {
			year: 'numeric', month: 'short', day: 'numeric',
			hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
		}).format(date);
		return `${countdown} (${timestamp})`;
	}

	function windowLabel(mins: number): string {
		if (mins % 1440 === 0) return `${mins / 1440}d`;
		if (mins % 60 === 0) return `${mins / 60}h`;
		return `${mins}m`;
	}

	function remainingPercent(window: RateLimitWindow): string {
		const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
		return Number.isInteger(remaining) ? String(remaining) : remaining.toFixed(1);
	}

	async function loadAccountUsage(host: string, force = false) {
		const key = host || LOCAL_HOST;
		const lastFetched = accountUsageFetchedAt[key] ?? 0;
		if (accountUsagePending[key] || (!force && Date.now() - lastFetched < 120_000)) return;
		accountUsagePending[key] = true;
		try {
			const res = await fetch(`/api/account${hostQuery(key)}`);
			if (!res.ok) throw new Error('account rate limits unavailable');
			const data = await res.json();
			const windows = Object.values(data.rateLimits ?? {}).filter(
				(value): value is RateLimitWindow =>
					Boolean(value) &&
					typeof value === 'object' &&
					typeof (value as RateLimitWindow).usedPercent === 'number' &&
					typeof (value as RateLimitWindow).windowDurationMins === 'number' &&
					typeof (value as RateLimitWindow).resetsAt === 'number'
			);
			accountUsageByHost[key] = {
				fiveHour: windows.find((window) => window.windowDurationMins === 300) ?? null,
				sevenDay: windows.find((window) => window.windowDurationMins === 10_080) ?? null
			};
			accountUsageFetchedAt[key] = Date.now();
		} catch {
			// Keep the last known values if a refresh briefly fails.
		} finally {
			accountUsagePending[key] = false;
		}
	}

	function fmtTokens(tokens: number): string {
		if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
		if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
		return tokens.toLocaleString();
	}

	function goalBudgetPercent(goal: Goal): number {
		if (!goal.tokenBudget) return 0;
		return Math.min(100, Math.round((goal.tokensUsed / goal.tokenBudget) * 100));
	}

	async function buildStatus(id: string): Promise<string> {
		const t = threads[id];
		const sess = sessions.find((s) => s.id === id);
		const lines = ['status'];
		lines.push(`  session   ${id}`);
		const cwd = cwds[id] ?? sess?.cwd;
		if (cwd) lines.push(`  cwd       ${cwd}`);
		const host = sessionHost(id);
		if (isRemoteHost(host)) {
			lines.push(`  host      ${host} (${hostStates[host] ?? 'connected'})`);
		}
		lines.push(`  state     ${t?.status ?? 'idle'}`);
		lines.push(`  fast      ${fastSessions[id] ? 'on' : 'off'}`);
		try {
			const res = await fetch(threadApi(id, '/model'));
			const settings = (await res.json()) as Partial<ModelState> & { error?: string };
			if (!res.ok) throw new Error(settings.error ?? 'model settings unavailable');
			if (settings.model) lines.push(`  model     ${settings.model}`);
			if (settings.effort) lines.push(`  effort    ${settings.effort}`);
		} catch {
			lines.push('  model     unavailable');
			lines.push('  effort    unavailable');
		}
		try {
			const res = await fetch(threadApi(id, '/profile'));
			const data = await res.json();
			if (res.ok && data.profile) lines.push(`  profile   ${data.profile}`);
		} catch {
			/* no profile line */
		}
		if (t?.tokens != null && t.contextWindow != null && t.contextWindow > 0) {
			const percent = ((t.tokens / t.contextWindow) * 100).toFixed(1);
			lines.push(
				`  context   ${t.tokens.toLocaleString()} / ${t.contextWindow.toLocaleString()} tokens (${percent}%)`
			);
		} else {
			lines.push('  context   unavailable');
		}
		if (t?.goal) lines.push(`  goal      ${t.goal.objective} (${t.goal.status})`);
		try {
			const acc = await (await fetch(`/api/account${hostQuery(sessionHost(id))}`)).json();
			const a = acc.account;
			if (a) lines.push(`  account   ${a.email ?? a.type}${a.planType ? ` · ${a.planType}` : ''}`);
			for (const win of [acc.rateLimits?.primary, acc.rateLimits?.secondary]) {
				if (win) {
					const label = `${windowLabel(win.windowDurationMins)} limit`.padEnd(9);
					lines.push(`  ${label} ${win.usedPercent}% used · resets in ${fmtReset(win.resetsAt)}`);
				}
			}
			const credits = acc.rateLimits?.credits;
			if (credits && !credits.unlimited) lines.push(`  credits   ${credits.balance ?? '0'}`);
		} catch {
			lines.push('  (account info unavailable)');
		}
		return lines.join('\n');
	}

	function formatModelState(settings: ModelState): string {
		const lines = [`model: ${settings.model || '(backend default)'}`];
		if (settings.effort) lines.push(`effort: ${settings.effort}`);
		if (settings.models.length > 0) {
			lines.push('', 'available models');
			for (const model of settings.models) {
				const efforts = model.efforts.length > 0 ? model.efforts.join(', ') : model.defaultEffort;
				lines.push(`  ${model.id.padEnd(24)} ${efforts}`);
			}
		} else {
			lines.push('', 'this backend does not advertise a model catalog');
		}
		lines.push('', 'usage: /model <model> [effort]');
		lines.push('       /model --effort <effort>');
		return lines.join('\n');
	}

	async function postCmd(id: string, path: string, body: unknown): Promise<any> {
		const res = await fetch(threadApi(id, `/${path}`), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body ?? {})
		});
		return { ok: res.ok, data: await res.json().catch(() => ({})) };
	}

	async function handleSlash(id: string, text: string) {
		const parsed = parseSlash(text);
		addLocalNote(id, text);

		switch (parsed.kind) {
			case 'help':
				addLocalNote(id, SLASH_HELP);
				break;

			case 'status':
				addLocalNote(id, await buildStatus(id));
				break;

			case 'fast': {
				const enabled = !fastSessions[id];
				const { ok, data } = await postCmd(id, 'fast', { enabled });
				if (ok) setFastSession(id, Boolean(data.enabled));
				addLocalNote(
					id,
					ok ? `Fast mode ${data.enabled ? 'enabled' : 'disabled'}` : data.error ?? 'failed to change Fast mode',
					ok ? 'info' : 'err'
				);
				break;
			}

			case 'model-show': {
				try {
					const res = await fetch(threadApi(id, '/model'));
					const data = await res.json();
					if (res.ok) {
						const settings = data as ModelState;
						if (settings.model) {
							sessionConfigs[id] = {
								model: settings.model,
								effort: settings.effort,
								profile: sessionConfigs[id]?.profile ?? null
							};
						}
						rememberEfforts(id, settings);
					}
					addLocalNote(
						id,
						res.ok ? formatModelState(data as ModelState) : data.error ?? 'failed to read model settings',
						res.ok ? 'info' : 'err'
					);
				} catch {
					addLocalNote(id, 'failed to read model settings', 'err');
				}
				break;
			}

			case 'model-set': {
				captureTurnModelBeforeConfigChange(id);
				const { ok, data } = await postCmd(id, 'model', {
					...(parsed.model ? { model: parsed.model } : {}),
					...(parsed.effort ? { effort: parsed.effort } : {})
				});
				addLocalNote(
					id,
					ok
						? `model set: ${data.model}${data.effort ? ` · effort ${data.effort}` : ''}`
						: data.error ?? 'failed to change model settings',
					ok ? 'info' : 'err'
				);
				if (ok) {
					sessionConfigs[id] = {
						model: data.model,
						effort: data.effort,
						profile: sessionConfigs[id]?.profile ?? null
					};
					// A new model may accept a different set of efforts.
					void loadSessionConfig(id);
				}
				break;
			}

			case 'profile-show': {
				try {
					const res = await fetch(threadApi(id, '/profile'));
					const data = await res.json();
					if (!res.ok) throw new Error(data.error);
					const lines = [`profile: ${data.profile ?? '(base config)'}`];
					const choices = (data.profiles ?? []) as ProfileChoice[];
					if (choices.length > 0) {
						lines.push('', 'available profiles');
						for (const p of choices) {
							lines.push(`  ${p.name.padEnd(24)} ${p.model ?? ''}`.trimEnd());
						}
					} else {
						lines.push('', 'no profiles found ($CODEX_HOME/<name>.config.toml)');
					}
					lines.push('', 'usage: /profile <name>', '       /profile clear');
					addLocalNote(id, lines.join('\n'));
				} catch {
					addLocalNote(id, 'failed to read profile', 'err');
				}
				break;
			}

			case 'profile-set': {
				captureTurnModelBeforeConfigChange(id);
				const { ok, data } = await postCmd(id, 'profile', { profile: parsed.profile });
				addLocalNote(
					id,
					ok ? `profile set: ${data.profile}` : data.error ?? 'failed to set profile',
					ok ? 'info' : 'err'
				);
				if (ok) void loadSessionConfig(id);
				break;
			}

			case 'profile-clear': {
				captureTurnModelBeforeConfigChange(id);
				const { ok, data } = await postCmd(id, 'profile', { clear: true });
				addLocalNote(
					id,
					ok ? 'profile cleared (base config)' : data.error ?? 'failed to clear profile',
					ok ? 'info' : 'err'
				);
				if (ok) void loadSessionConfig(id);
				break;
			}

			case 'goal-show': {
				let g = threads[id]?.goal;
				try {
					const res = await fetch(threadApi(id, '/goal'));
					const data = await res.json();
					if (res.ok) {
						g = (data.goal ?? null) as Goal | null;
						ensureThread(id).goal = g;
					}
				} catch {
					/* use locally cached goal */
				}
				addLocalNote(id, g ? `goal: ${g.objective} (${g.status})` : 'no goal set');
				break;
			}

			case 'goal-clear': {
				const { ok, data } = await postCmd(id, 'goal', { clear: true });
				if (ok) ensureThread(id).goal = null;
				addLocalNote(id, ok ? 'goal cleared' : data.error ?? 'failed to clear goal', ok ? 'info' : 'err');
				break;
			}

			case 'goal-set': {
				const body =
					parsed.tokenBudget === undefined
						? { objective: parsed.objective }
						: { objective: parsed.objective, tokenBudget: parsed.tokenBudget };
				const { ok, data } = await postCmd(id, 'goal', body);
				if (ok && data.goal) ensureThread(id).goal = data.goal as Goal;
				addLocalNote(
					id,
					ok ? `goal set: ${parsed.objective}` : data.error ?? 'failed to set goal',
					ok ? 'info' : 'err'
				);
				break;
			}

			case 'todo-add':
				queueTodo(id, parsed.task);
				break;

			case 'todo-remove': {
				const result = removePendingTodo(todoQueues[id], parsed.position);
				if ('error' in result) addLocalNote(id, result.error, 'err');
				else {
					todoQueues = { ...todoQueues, [id]: result.queue };
					persistTodoQueues();
					addLocalNote(id, `Removed queued todo ${parsed.position}.`, 'info');
				}
				break;
			}

			case 'todo-show': {
				const queue = todoQueues[id];
				if (!queue?.tasks.length) addLocalNote(id, 'no queued todos');
				else {
					const offset = queue.initialTask ? 1 : 0;
					const total = queue.tasks.length + offset;
					const lines = queue.tasks.map((task, index) => {
						const position = index + 1 + offset;
						const state = index < queue.startedCount
							? index === queue.startedCount - 1 && queue.currentTask ? 'current' : 'done'
							: 'queued';
						return `[${position}/${total}] ${state} · ${task}`;
					});
					if (queue.initialTask) {
						const isRunning = queue.startedCount === 0 && threads[id]?.status === 'running';
						lines.unshift(`[1/${total}] ${isRunning ? 'current' : 'done'} · ${queue.initialTask}`);
					}
					addLocalNote(id, lines.join('\n'));
				}
				break;
			}

			case 'todo-clear': {
				const queue = todoQueues[id];
				if (!queue) addLocalNote(id, 'no queued todos');
				else if (queue.currentTask && threads[id]?.status === 'running') {
					todoQueues = { ...todoQueues, [id]: { ...queue, tasks: queue.tasks.slice(0, queue.startedCount) } };
					persistTodoQueues();
					addLocalNote(id, 'cleared pending todos; current todo will finish', 'info');
				} else {
					const { [id]: _cleared, ...remaining } = todoQueues;
					todoQueues = remaining;
					persistTodoQueues();
					addLocalNote(id, 'cleared queued todos', 'info');
				}
				break;
			}

			case 'compact': {
				const t = ensureThread(id);
				t.status = 'running';
				const { ok, data } = await postCmd(id, 'compact', {});
				if (!ok) t.status = 'idle';
				addLocalNote(id, ok ? 'compacting history…' : data.error ?? 'failed to compact', ok ? 'info' : 'err');
				break;
			}

			case 'review': {
				const t = ensureThread(id);
				t.status = 'running';
				const { ok, data } = await postCmd(
					id,
					'review',
					parsed.instructions ? { instructions: parsed.instructions } : {}
				);
				if (!ok) {
					t.status = 'idle';
					addLocalNote(id, data.error ?? 'failed to start review', 'err');
				} else {
					addLocalNote(id, 'review started');
				}
				break;
			}

			case 'shell': {
				const t = ensureThread(id);
				t.status = 'running';
				const { ok, data } = await postCmd(id, 'shell', { command: parsed.command });
				if (!ok) t.status = 'idle';
				addLocalNote(id, ok ? 'shell command started' : data.error ?? 'failed to start shell command', ok ? 'info' : 'err');
				break;
			}

			case 'rollback': {
				const { ok, data } = await postCmd(id, 'rollback', { numTurns: parsed.numTurns });
				if (ok) {
					replaceItems(id, data.thread?.turns ?? []);
					addLocalNote(id, `rolled back ${parsed.numTurns} turn${parsed.numTurns === 1 ? '' : 's'}`);
				} else {
					addLocalNote(id, data.error ?? 'failed to roll back', 'err');
				}
				break;
			}

			case 'fork': {
				const { ok, data } = await postCmd(id, 'fork', {});
				if (ok && data.thread?.id) {
					upsertSession({ ...data.thread, host: data.host ?? sessionHost(id) });
					ensureThread(data.thread.id);
					addLocalNote(id, `forked into ${data.thread.id.slice(0, 8)}`);
					goto(`/s/${data.thread.id}${hostQuery(data.host ?? sessionHost(id))}`);
				} else {
					addLocalNote(id, data.error ?? 'failed to fork session', 'err');
				}
				break;
			}

			case 'btw': {
				if (isSideChat(sessions.find((s) => s.id === id))) {
					addLocalNote(id, 'already in a side conversation — go back first', 'err');
					break;
				}
				const { ok, data } = await postCmd(id, 'fork', {
					ephemeral: true,
					developerInstructions: BTW_DEVELOPER_INSTRUCTIONS
				});
				if (!ok || !data.thread?.id) {
					addLocalNote(id, data.error ?? 'failed to start side conversation', 'err');
					break;
				}
				const sideId: string = data.thread.id;
				sessionStorage.setItem(sideParentKey(sideId), id);
				upsertSession({
					...data.thread,
					forkedFromId: id,
					ephemeral: true,
					host: data.host ?? sessionHost(id)
				});
				ensureThread(sideId);
				addLocalNote(id, `side conversation started: ${sideId.slice(0, 8)}`);
				if (parsed.message) {
					const t = ensureThread(sideId);
					t.status = 'running';
					const echoId = addLocalUserMessage(sideId, parsed.message);
					const res = await sendMessageWithRetries(sideId, parsed.message, []);
					if (!res.ok) {
						t.status = 'idle';
						removeLocalItem(sideId, echoId);
						const err = await res.json().catch(() => ({}));
						addLocalNote(sideId, err.error ?? 'failed to send message', 'err');
					}
				}
				goto(`/s/${sideId}${hostQuery(data.host ?? sessionHost(id))}`);
				break;
			}

			case 'archive': {
				const session = sessions.find((session) => session.id === id);
				if (session && isSideChat(session)) {
					const result = await closeSideChat(session);
					if (result.ok) {
						showArchiveNotice({ tone: 'info', message: `Deleted ${shortLabel(session)}` });
					} else {
						addLocalNote(id, result.error ?? 'failed to delete side conversation', 'err');
					}
					break;
				}
				const { ok, data } = await postCmd(id, 'archive', {});
				if (ok) {
					removeSession(id);
					if (activeId === id) goto('/');
				} else {
					addLocalNote(id, data.error ?? 'failed to archive session', 'err');
				}
				break;
			}

			default:
				addLocalNote(id, `unknown command: ${parsed.command} — try /help`, 'err');
		}
	}

	function reportDiagnostics(id: string, event: string) {
		void fetch(threadApi(id, '/diagnostics'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ event, connected, visible: document.visibilityState === 'visible' }),
			signal: AbortSignal.timeout(3_000)
		}).catch(() => {});
	}

	async function interrupt() {
		const id = activeId;
		if (!id || stoppingSessions[id]) return;
		await interruptThread(id, sessionHost(id));
	}

	async function interruptThread(id: string, host: string): Promise<boolean> {
		if (stoppingSessions[id]) return false;
		stoppingSessions[id] = true;
		void fetch(threadApi(id, '/diagnostics', host), {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ event: 'stop_requested', connected, visible: document.visibilityState === 'visible' }),
			signal: AbortSignal.timeout(3_000)
		}).catch(() => {});
		try {
			// Re-read the live turn: restored history or a missed SSE event can
			// leave the UI's turn ID missing or out of date.
			const url = new URL(threadApi(id, '', host), window.location.origin);
			url.searchParams.set('turns', '1');
			const read = await fetch(url, { signal: AbortSignal.timeout(15_000) });
			const data = await read.json();
			if (!read.ok) throw new Error(data.error ?? `Could not check current turn (${read.status})`);
			const thread = data.thread;
			if (!thread) throw new Error('Could not check current turn: no thread returned');
			syncThreadRuntime(id, thread);
			if (thread.status?.type === 'idle' || thread.status?.type === 'notLoaded') {
				addLocalNote(id, 'Task was already stopped.');
				return false;
			}
			const turnId = thread.turns?.findLast((turn: Turn) => turn.status === 'inProgress')?.id;
			if (!turnId) throw new Error('Could not find the running turn. Try Stop again.');
			const response = await fetch(threadApi(id, '/interrupt', host), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ turnId }),
				signal: AbortSignal.timeout(15_000)
			});
			if (!response.ok) {
				const error = await response.json().catch(() => ({}));
				throw new Error(error.error ?? `Stop failed (${response.status})`);
			}
			void fetch(threadApi(id, '/diagnostics', host), {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ event: 'stop_succeeded', connected, visible: document.visibilityState === 'visible' }),
				signal: AbortSignal.timeout(3_000)
			}).catch(() => {});
			addLocalNote(id, 'Task stopped.');
			// A new turn may have started while the cancellation was in flight.
			const t = ensureThread(id);
			if (t.turnId === turnId) {
				t.status = 'idle';
				t.turnId = null;
				delete activeTurnBySession[id];
				const { [id]: _stoppedTurnModel, ...remainingTurnModels } = turnModels;
				turnModels = remainingTurnModels;
				const { [id]: _stoppedTurnEffort, ...remainingTurnEfforts } = turnEfforts;
				turnEfforts = remainingTurnEfforts;
				markTaskCompleted(id);
			}
			return true;
		} catch (error) {
			void fetch(threadApi(id, '/diagnostics', host), {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ event: 'stop_failed', connected, visible: document.visibilityState === 'visible' }),
				signal: AbortSignal.timeout(3_000)
			}).catch(() => {});
			addLocalNote(id, `Could not stop task: ${error instanceof Error ? error.message : String(error)}`, 'err');
			return false;
		} finally {
			delete stoppingSessions[id];
		}
	}

	async function waitForTurnIdle(id: string) {
		for (let attempt = 0; attempt < 40; attempt += 1) {
			const url = new URL(threadApi(id), window.location.origin);
			url.searchParams.set('turns', '1');
			const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
			const data = await response.json();
			if (!response.ok) throw new Error(data.error ?? `Could not verify stopped turn (${response.status})`);
			if (!data.thread) throw new Error('Could not verify stopped turn: no thread returned');
			syncThreadRuntime(id, data.thread);
			if (data.thread.status?.type === 'idle' || data.thread.status?.type === 'notLoaded') {
				// Give the matching turn/completed SSE notification a moment to land
				// before starting another turn on the same thread.
				await new Promise((resolve) => setTimeout(resolve, 250));
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error('The current turn did not stop in time. Try again once it is idle.');
	}

	async function restartPromptWithSelectedSettings() {
		const id = activeId;
		if (!id || !activeSettingsChangedDuringTurn || activeTodoQueue || switchingPromptModel || sendingMessage) return;
		const latestUserMessage = [...itemsOf(threads[id])].reverse().find((item) => item.type === 'userMessage') as any;
		const promptText = (latestUserMessage?.content ?? [])
			.map((part: any) => typeof part?.text === 'string' ? visibleUserText(part.text) : '')
			.join('')
			.trim();
		const prompt = promptText || 'Please repeat the request from my immediately preceding message.';
		const modelName = activeModelChoice?.displayName ?? activeConfig?.model ?? 'the selected model';
		const selectedEffort = activeConfig?.effort ?? '';
		switchingPromptModel = true;
		sendingMessage = true;
		try {
			await interrupt();
			await waitForTurnIdle(id);
			const thread = ensureThread(id);
			thread.status = 'running';
			thread.turnStartedAt = Date.now();
			thread.error = null;
			turnModels = { ...turnModels, [id]: sessionConfigs[id]?.model ?? '' };
			turnEfforts = { ...turnEfforts, [id]: sessionConfigs[id]?.effort ?? '' };
			restartPromptEchoes[id] = [...(restartPromptEchoes[id] ?? []), prompt];
			try {
				const response = await sendMessageWithRetries(id, prompt, []);
				if (!response.ok) {
					const data = await response.json().catch(() => ({}));
					throw new Error(data.error ?? `Could not restart prompt (${response.status})`);
				}
				addLocalNote(id, `Restarted the prompt on ${modelName} with ${effortLabel(selectedEffort)} thinking. The previous partial attempt remains in this transcript.`, 'info');
			} catch (error) {
				thread.status = 'idle';
				thread.turnStartedAt = null;
				restartPromptEchoes[id] = (restartPromptEchoes[id] ?? []).filter((queuedPrompt) => queuedPrompt !== prompt);
				const { [id]: _failedModel, ...remainingModels } = turnModels;
				turnModels = remainingModels;
				const { [id]: _failedEffort, ...remainingEfforts } = turnEfforts;
				turnEfforts = remainingEfforts;
				throw error;
			}
		} catch (error) {
			addLocalNote(id, error instanceof Error ? error.message : 'Could not switch the running prompt', 'err');
		} finally {
			switchingPromptModel = false;
			sendingMessage = false;
		}
	}

	async function playInterruptedSession() {
		const id = activeId;
		if (!id || !interruptedSessions[id] || sendingMessage) return;
		sendingMessage = true;
		try {
			await openSession(id, false);
			if (conflict?.id === id) return;
			const thread = ensureThread(id);
			thread.status = 'running';
			const echoId = addLocalUserMessage(id, RESTART_CONTINUATION_PROMPT);
			try {
				const response = await sendMessageWithRetries(id, RESTART_CONTINUATION_PROMPT, []);
				if (!response.ok) {
					const data = await response.json().catch(() => ({}));
					throw new Error(data.error ?? `Could not continue session (${response.status})`);
				}
				delete interruptedSessions[id];
				persistInterruptedSessions();
			} catch (error) {
				thread.status = 'idle';
				removeLocalItem(id, echoId);
				addLocalNote(id, error instanceof Error ? error.message : 'Could not continue session', 'err');
			}
		} catch (error) {
			addLocalNote(id, error instanceof Error ? error.message : 'Could not reopen session', 'err');
		} finally {
			sendingMessage = false;
		}
	}

	async function resumeStoppedTask(sessionId: string, noteId: string) {
		if (sendingMessage || threads[sessionId]?.status === 'running') return;
		sendingMessage = true;
		try {
			const thread = ensureThread(sessionId);
			thread.status = 'running';
			thread.turnStartedAt = Date.now();
			thread.error = null;
			const echoId = addLocalUserMessage(sessionId, STOPPED_CONTINUATION_PROMPT);
			restartPromptEchoes[sessionId] = [...(restartPromptEchoes[sessionId] ?? []), STOPPED_CONTINUATION_PROMPT];
			try {
				const response = await sendMessageWithRetries(sessionId, STOPPED_CONTINUATION_PROMPT, []);
				if (!response.ok) {
					const data = await response.json().catch(() => ({}));
					throw new Error(data.error ?? `Could not resume task (${response.status})`);
				}
				const note = threads[sessionId]?.byId[noteId] as any;
				if (note) threads[sessionId].byId[noteId] = { ...note, resumeAvailable: false, text: 'Task resumed.' };
			} catch (error) {
				thread.status = 'idle';
				thread.turnStartedAt = null;
				removeLocalItem(sessionId, echoId);
				restartPromptEchoes[sessionId] = (restartPromptEchoes[sessionId] ?? []).filter((prompt) => prompt !== STOPPED_CONTINUATION_PROMPT);
				addLocalNote(sessionId, error instanceof Error ? error.message : 'Could not resume task', 'err');
			}
		} finally {
			sendingMessage = false;
		}
	}

	function showArchiveNotice(notice: ArchiveNotice, duration = 8000) {
		if (archiveNoticeTimer) clearTimeout(archiveNoticeTimer);
		archiveNotice = notice;
		archiveNoticeTimer = setTimeout(() => {
			archiveNotice = null;
			archiveNoticeTimer = null;
		}, duration);
	}

	async function renameSession(id: string) {
		const session = sessions.find((entry) => entry.id === id);
		if (!session || isSideChat(session)) return;
		const name = window.prompt('Rename session', session.name ?? shortLabel(session));
		if (name === null) return;
		const trimmed = name.trim();
		if (!trimmed || trimmed === session.name) return;
		try {
			const response = await fetch(threadApi(id, '/name'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: trimmed })
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error ?? 'Could not rename session');
			sessions = sessions.map((entry) => entry.id === id ? { ...entry, name: trimmed } : entry);
		} catch (error) {
			showArchiveNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not rename session' }, 6000);
		}
	}

	async function clearSession(id: string) {
		const session = sessions.find((entry) => entry.id === id);
		if (!session || isSideChat(session) || clearingSessionId || sendingMessage) return;
		const host = sessionHost(id);
		const config = sessionConfigs[id] ? { ...sessionConfigs[id] } : null;
		const cwd = cwds[id] ?? session.cwd;
		const name = session.name;
		const fast = Boolean(fastSessions[id]);
		const originalOrder = topSessions.map((entry) => entry.id);
		let createdId: string | null = null;
		const request = async (url: string, body?: object) => {
			const response = await fetch(url, body === undefined ? { signal: AbortSignal.timeout(15_000) } : {
				method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000)
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error ?? `Clear session failed (${response.status})`);
			return data;
		};
		clearingSessionId = id;
		try {
			const data = await replaceSessionWithEmptyThread({
				assertIdle: async () => {
					if (threads[id]?.status === 'running' || agentsForSession(agents, id).some(agentIsRunning)) {
						throw new Error('Finish or stop this session and its agents before clearing it.');
					}
					const live = await request(threadApi(id));
					if (!live.thread || live.thread.status?.type === 'active') throw new Error('The session is working; stop it before clearing it.');
				},
				create: async () => {
					// The thread/started SSE event can beat the HTTP creation reply.
					// Stage additions until we know which ID is our replacement.
					clearCreationSnapshot = new Set(sessions.map((entry) => entry.id));
					const fresh = await request('/api/threads', { host, cwd, ...(config ? { model: config.model, effort: config.effort, profile: config.profile } : {}) });
					createdId = fresh.thread?.id ?? null;
					clearReplacementId = createdId;
					clearCreationSnapshot = null;
					if (createdId) {
						rememberEmptySession(createdId, host);
						const thread = ensureThread(createdId);
						thread.tokens = 0;
						sessionHistoryLoaded[createdId] = true;
						upsertSession({ ...fresh.thread, host });
					}
					return fresh;
				},
				configure: async (newId) => {
					if (sessionRules[id]) saveSessionRules(newId, { ...sessionRules[id] });
					if (config?.model) await request(threadApi(newId, '/model', host), { model: config.model, effort: config.effort });
					if (config) sessionConfigs[newId] = { ...config };
					if (name) {
						await request(threadApi(newId, '/name', host), { name });
						sessions = sessions.map((entry) => entry.id === newId ? { ...entry, name } : entry);
					}
					setFastSession(newId, fast);
				},
				archive: async () => { await request(threadApi(id, '/archive', host), {}); }
			});
			const newId = data.thread!.id!;
			removeSession(id);
			sessionOrder = [...originalOrder.map((entry) => entry === id ? newId : entry), ...sessionOrder.filter((entry) => entry !== newId && !originalOrder.includes(entry))];
			localStorage.setItem(SESSION_ORDER_KEY, JSON.stringify(sessionOrder));
			clearReplacementId = null;
			sessionInfoDialog?.close();
			await goto(`/s/${newId}${hostQuery(host)}`);
			showArchiveNotice({ tone: 'info', message: 'Session cleared to 0 conversation tokens. Previous history is in Archived sessions.' });
		} catch (error) {
			showArchiveNotice({ tone: 'error', message: `${error instanceof Error ? error.message : 'Could not clear session.'}${createdId ? ' The original history was kept; the new session is available in the list.' : ''}` });
		} finally {
			clearCreationSnapshot = null;
			clearReplacementId = null;
			clearingSessionId = null;
		}
	}

	async function deleteSession(id: string) {
		const session = sessions.find((s) => s.id === id);
		if (!session) return;
		const label = shortLabel(session);
		if (isSideChat(session)) {
			const result = await closeSideChat(session);
			if (!result.ok) {
				showArchiveNotice(
					{ tone: 'error', message: result.error ?? 'Could not delete the side conversation.' },
					6000
				);
				return;
			}
			showArchiveNotice({ tone: 'info', message: `Deleted ${label}` });
			return;
		}
		const snapshot: ArchivedSessionSnapshot = {
			id,
			label,
			index: sessions.findIndex((s) => s.id === id),
			summary: { ...session, host: sessionHost(id) },
			thread: threads[id],
			config: sessionConfigs[id],
			cwd: cwds[id]
		};
		const res = await fetch(threadApi(id, '/archive'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			showArchiveNotice({ tone: 'error', message: data.error ?? 'Could not archive the session.' }, 6000);
			return;
		}
		removeSession(id);
		showArchiveNotice({ tone: 'undo', message: `Archived ${label}`, snapshot });
		if (activeId === id) goto('/');
	}

	async function closeSideChat(
		session: ThreadSummary
	): Promise<{ ok: true } | { ok: false; error?: string }> {
		const res = await fetch(threadApi(session.id, '/unsubscribe'), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			return { ok: false, error: data.error };
		}
		const wasActive = activeId === session.id;
		const parentId = session.forkedFromId;
		removeSession(session.id);
		if (wasActive) {
			await goto(parentId && sessions.some((item) => item.id === parentId) ? `/s/${parentId}` : '/');
		}
		return { ok: true };
	}

	async function undoArchivedSession() {
		const snapshot = archiveNotice?.snapshot;
		if (!snapshot) return;
		if (archiveNoticeTimer) clearTimeout(archiveNoticeTimer);
		archiveNoticeTimer = null;
		const res = await fetch(threadApi(snapshot.id, '/unarchive', snapshot.summary.host ?? LOCAL_HOST), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			showArchiveNotice({ tone: 'error', message: data.error ?? 'Could not restore the session.' }, 6000);
			return;
		}
		const data = await res.json().catch(() => ({}));
		if (snapshot.thread) threads[snapshot.id] = snapshot.thread;
		if (snapshot.config) sessionConfigs[snapshot.id] = snapshot.config;
		if (snapshot.cwd) cwds[snapshot.id] = snapshot.cwd;
		const restored = { ...snapshot.summary, ...(data.thread ?? {}), host: snapshot.summary.host ?? LOCAL_HOST } as ThreadSummary;
		const next = sessions.filter((session) => session.id !== snapshot.id);
		next.splice(Math.min(Math.max(snapshot.index, 0), next.length), 0, restored);
		sessions = next;
		archiveNotice = null;
	}

	async function openArchiveBrowser() {
		archiveFilter = 'all';
		archiveBrowserDialog?.showModal();
		await loadArchivedSessions();
	}

	async function loadArchivedSessions() {
		archivedSessionsLoading = true;
		archivedSessionsError = null;
		try {
			await loadHostChoices();
			const catalog = await loadArchiveCatalog(hostChoices, async (host) => {
				const response = await fetch(`/api/threads?archived=true${host ? `&host=${encodeURIComponent(host)}` : ''}`, { signal: AbortSignal.timeout(20_000) });
				const data = await response.json().catch(() => ({}));
				if (!response.ok) throw new Error(data.error ?? `Archive unavailable (${response.status})`);
				return data.data ?? [];
			});
			archivedSessions = catalog.sessions;
			archivedSessionsError = catalog.errors.join(' · ') || null;
		} catch (error) {
			archivedSessionsError = error instanceof Error ? error.message : String(error);
		} finally {
			archivedSessionsLoading = false;
		}
	}

	async function restoreArchivedSession(session: ThreadSummary) {
		if (restoringArchivedSessionId || deletingArchivedSessionId) return;
		restoringArchivedSessionId = session.id;
		try {
			const response = await fetch(`/api/threads/${session.id}/unarchive${hostQuery(session.host)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({})
			});
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error ?? 'Could not restore the session.');
			const restored = { ...session, ...(data.thread ?? {}), host: session.host ?? LOCAL_HOST } as ThreadSummary;
			upsertSession(restored);
			archivedSessions = archivedSessions.filter((entry) => entry.id !== session.id);
			showArchiveNotice({ tone: 'info', message: `Restored ${shortLabel(restored)}` });
		} catch (error) {
			showArchiveNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) }, 6000);
		} finally {
			restoringArchivedSessionId = null;
		}
	}

	async function deleteArchivedSession(session: ThreadSummary) {
		if (restoringArchivedSessionId || deletingArchivedSessionId) return;
		if (!archiveDeletionSupported(session, hostChoices)) return;
		const label = shortLabel(session);
		if (!window.confirm(`Permanently delete “${label}”? This cannot be undone.`)) return;
		deletingArchivedSessionId = session.id;
		try {
			await performArchiveDeletion(session);
			showArchiveNotice({ tone: 'info', message: `Permanently deleted ${label}` });
		} catch (error) {
			showArchiveNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) }, 6000);
		} finally {
			deletingArchivedSessionId = null;
		}
	}

	async function performArchiveDeletion(session: ThreadSummary) {
		const response = await fetch(`/api/threads/${session.id}/delete${hostQuery(session.host)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error ?? 'Could not delete the archived session.');
		archivedSessions = archivedSessions.filter((entry) => entry.id !== session.id || entry.host !== session.host);
	}

	async function deleteAllArchivedSessions() {
		if (restoringArchivedSessionId || deletingArchivedSessionId || !deletableArchives.length) return;
		const targets = [...deletableArchives];
		const skipped = visibleArchivedSessions.length - targets.length;
		if (!window.confirm(`Permanently delete ${targets.length} archived session(s) in the ${archiveFilter} filter? This cannot be undone.${skipped ? ` ${skipped} unsupported Claude session(s) will remain untouched.` : ''}`)) return;
		deletingAllArchives = true;
		let deleted = 0;
		const errors: string[] = [];
		try {
			for (const session of targets) {
				deletingArchivedSessionId = session.id;
				try { await performArchiveDeletion(session); deleted++; }
				catch (error) { errors.push(`${shortLabel(session)}: ${error instanceof Error ? error.message : String(error)}`); }
			}
			showArchiveNotice({ tone: errors.length ? 'error' : 'info', message: `Deleted ${deleted} archived session(s).${skipped ? ` ${skipped} unsupported Claude session(s) were left untouched.` : ''}${errors.length ? ` ${errors.length} failed: ${errors.join(' · ')}` : ''}` }, 10000);
		} finally {
			deletingArchivedSessionId = null;
			deletingAllArchives = false;
		}
	}

	function tooltipInTopLayer(node: HTMLElement, _tooltip: unknown) {
		const show = () => { try { if (node.matches(':popover-open')) node.hidePopover(); node.showPopover(); } catch { /* Older browsers retain the positioned tooltip. */ } };
		show();
		return { update: show, destroy() { try { node.hidePopover(); } catch { /* Already removed. */ } } };
	}

	function onKeydown(e: KeyboardEvent) {
		// The slash popup owns its keys while visible (codex TUI precedence:
		// command popup before history navigation and submission).
		if (slashPopupVisible && handleSlashPopupKey(e)) return;
		// Mobile keyboards use Return for multiline composition; the adjacent
		// send button stays in thumb reach. Desktop keeps the fast Enter-to-send
		// convention, with Shift+Enter for a newline.
		if (sendsMessage(e, settings.enterToSend && !mobileViewport)) {
			e.preventDefault();
			send();
			return;
		}
		if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.isComposing) {
			handleHistoryNavigation(e);
		}
	}

	function handleSlashPopupKey(e: KeyboardEvent): boolean {
		if (e.isComposing) return false;
		const matches = slashMatches;
		const moveUp = (e.key === 'ArrowUp' && !e.ctrlKey) || (e.key === 'p' && e.ctrlKey);
		const moveDown = (e.key === 'ArrowDown' && !e.ctrlKey) || (e.key === 'n' && e.ctrlKey);
		if ((moveUp || moveDown) && !e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			slashIndex = (slashIndex + (moveDown ? 1 : -1) + matches.length) % matches.length;
			void tick().then(() =>
				document
					.getElementById(slashOptionId(matches[slashIndex]))
					?.scrollIntoView({ block: 'nearest' })
			);
			return true;
		}
		if (e.key === 'Tab' && !e.shiftKey) {
			e.preventDefault();
			acceptSlashCompletion(matches[slashIndex], false);
			return true;
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			// Enter runs the highlighted command, like the codex TUI.
			e.preventDefault();
			acceptSlashCompletion(matches[slashIndex], true);
			return true;
		}
		if (e.key === 'Escape') {
			// Dismiss without touching the draft; the popup stays hidden until
			// the typed command token changes.
			e.preventDefault();
			slashDismissedToken = slashToken;
			return true;
		}
		return false;
	}

	function slashOptionId(cmd: SlashCommandInfo): string {
		return `slash-option-${cmd.name.slice(1)}`;
	}

	function acceptSlashCompletion(cmd: SlashCommandInfo, submit: boolean) {
		slashDismissedToken = null;
		// Tab completion leaves a trailing space when the command takes
		// arguments, so typing continues naturally.
		input = submit ? cmd.name : cmd.name + (cmd.args ? ' ' : '');
		if (submit) {
			void send();
			return;
		}
		void tick().then(() => {
			if (!composerTextareaEl) return;
			composerTextareaEl.focus();
			resizeComposer();
			const end = composerTextareaEl.value.length;
			composerTextareaEl.setSelectionRange(end, end);
		});
	}

	// Prior user messages for a resumed thread, oldest first — the seed for
	// Up/Down recall (the codex TUI's replayed-submission history).
	function transcriptUserTexts(id: string): string[] {
		const t = threads[id];
		if (!t) return [];
		const texts: string[] = [];
		for (const itemId of t.order) {
			const item = t.byId[itemId] as any;
			if (item?.type !== 'userMessage') continue;
			const text = ((item.content ?? []) as any[])
				.map((c) => (typeof c?.text === 'string' ? visibleUserText(c.text) : ''))
				.filter(Boolean)
				.join('\n')
				.trim();
			if (text) texts.push(text);
		}
		return texts;
	}

	function composerHistoryOf(id: string): ComposerHistory {
		let history = composerHistories.get(id);
		if (!history) {
			history = new ComposerHistory();
			composerHistories.set(id, history);
		}
		if (history.isEmpty) history.seed(transcriptUserTexts(id));
		return history;
	}

	function handleHistoryNavigation(e: KeyboardEvent) {
		if (!activeId || !composerTextareaEl) return;
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		// A live selection means the arrows should collapse it, not recall.
		if (composerTextareaEl.selectionStart !== composerTextareaEl.selectionEnd) return;

		const history = composerHistoryOf(activeId);
		if (!history.shouldHandleNavigation(input, composerTextareaEl.selectionStart)) return;

		const nav = e.key === 'ArrowUp' ? history.navigateUp() : history.navigateDown();
		if (nav.kind === 'ignored') return;
		e.preventDefault();
		input = nav.kind === 'recall' ? nav.text : '';
		// Recall places the caret at the end, like shell history.
		void tick().then(() => {
			if (!composerTextareaEl) return;
			resizeComposer();
			const end = composerTextareaEl.value.length;
			composerTextareaEl.setSelectionRange(end, end);
		});
	}

	function resizeComposer() {
		if (!composerTextareaEl) return;
		composerTextareaEl.style.height = 'auto';
		const maxHeight = Number.parseFloat(getComputedStyle(composerTextareaEl).maxHeight);
		const nextHeight = Math.min(composerTextareaEl.scrollHeight, maxHeight);
		composerTextareaEl.style.height = `${nextHeight}px`;
		composerTextareaEl.style.overflowY = composerTextareaEl.scrollHeight > maxHeight ? 'auto' : 'hidden';
	}

	$effect(() => {
		input;
		void tick().then(resizeComposer);
	});

	// Selection restarts at the top match whenever the typed token changes.
	$effect(() => {
		slashToken;
		slashIndex = 0;
	});

	function onCwdKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			newSession(newCwd.trim() || undefined);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			if (cwdBrowseOpen) cwdBrowseOpen = false;
			else cancelCreating();
		}
	}

	function itemsOf(t: ThreadState | null): ThreadItem[] {
		if (!t) return [];
		return t.order.map((id) => t.byId[id]).filter(Boolean);
	}

	function isRenderableTranscriptItem(item: ThreadItem): boolean {
		return item.type !== 'reasoning' || Boolean(reasoningText(item));
	}

	function imageSrc(path: string): string {
		if (/^https?:\/\//i.test(path)) return path;
		if (isRemoteHost(activeHost)) {
			return `/api/images?path=${encodeURIComponent(path)}&host=${encodeURIComponent(activeHost)}`;
		}
		return `/api/images?path=${encodeURIComponent(path)}`;
	}

	function markdownImageSrc(path: string): string | null {
		if (/^https?:\/\//i.test(path)) return path;
		const target = agentPathTarget(path, false);
		if (!target || !activeId) return null;
		const cwd = (cwds[activeId] ?? activeSummary?.cwd)?.replace(/[\\/]+$/, '');
		if (!cwd) return null;
		return imageSrc(`${cwd}/${target.path}`);
	}

	function imageLabel(path: string): string {
		return path.split('/').filter(Boolean).at(-1) ?? path;
	}

	function userParts(item: any): RenderPart[] {
		const parts: RenderPart[] = [];
		for (const c of item.content ?? []) {
			if (typeof c?.text === 'string' && c.text) {
				const frames = viewedId ? attributeRelayPart(c.text, { threadId: viewedId, turnId: item._turnId }, relayStore.records) : null;
				if (frames) {
					parts.push({ type: 'relay', frames });
					continue;
				}
				const text = visibleUserText(c.text);
				if (text) parts.push({ type: 'text', text });
			}
			if (c?.type === 'localImage' && typeof c.path === 'string') {
				parts.push({ type: 'image', path: c.path, source: 'local' });
			}
			if (c?.type === 'image' && typeof c.url === 'string') {
				parts.push({ type: 'image', path: c.url, source: 'remote' });
			}
		}
		return parts;
	}

	function agentParts(text: string): RenderPart[] {
		text = stripTaskProgressMarkers(text);
		const parts: RenderPart[] = [];
		const re = /<agent-img>\s*([\s\S]*?)\s*<\/agent-img>/g;
		let last = 0;
		let match: RegExpExecArray | null;
		while ((match = re.exec(text))) {
			if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) });
			const path = match[1]?.trim();
			if (path) parts.push({ type: 'image', path, source: /^https?:\/\//i.test(path) ? 'remote' : 'local' });
			last = re.lastIndex;
		}
		if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
		return parts;
	}

	function formatEstimatedRemaining(minutes: number | null): string {
		if (minutes === null) return 'time unknown';
		if (minutes < 60) return `~${minutes}m left`;
		const hours = Math.floor(minutes / 60);
		const remainder = minutes % 60;
		return remainder ? `~${hours}h ${remainder}m left` : `~${hours}h left`;
	}

	function progressEntryRemaining(item: any, index: number): number | null {
		let elapsed = 0;
		if (item.turnId && item.turnId === viewed?.turnId && viewed?.turnStartedAt !== null && viewed?.turnStartedAt !== undefined) {
			// Judge each entry by the time it was reported, so it does not drift.
			elapsed = (typeof item.at === 'number' ? item.at : activityClock) - viewed.turnStartedAt;
		} else if (item.turnId && typeof item.at === 'number') {
			for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
				const previous = viewedItems[previousIndex] as any;
				if (previous.type === 'taskProgress' && previous.turnId === item.turnId && previous.percent < item.percent && typeof previous.at === 'number') {
					elapsed = item.at - previous.at;
					const gained = item.percent - previous.percent;
					return Math.max(1, Math.ceil((elapsed * (100 - item.percent)) / gained / 60_000));
				}
			}
		}
		return estimateRemainingMinutes(item.percent, item.remainingMinutes, elapsed, isClaudeSession(activeId) && settings.claudeTimeCalibration);
	}

	function chooseAttachments() {
		imageInputEl?.click();
	}

	const promptImageMimeByExtension: Record<string, string> = {
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		webp: 'image/webp',
		gif: 'image/gif'
	};

	function supportedPromptImage(file: File): File | null {
		const mime = file.type.toLowerCase().split(';', 1)[0];
		if (Object.values(promptImageMimeByExtension).includes(mime)) return file;
		const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
		const inferredMime = promptImageMimeByExtension[extension];
		return inferredMime ? new File([file], file.name, { type: inferredMime, lastModified: file.lastModified }) : null;
	}

	const promptFileExtensions = new Set([
		'pdf', 'txt', 'text', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonl',
		'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less',
		'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'pyw', 'go', 'rs', 'java', 'kt',
		'c', 'h', 'cc', 'hh', 'cpp', 'hpp', 'cs', 'fs', 'rb', 'php', 'pl', 'pm', 'sh',
		'bash', 'zsh', 'fish', 'sql', 'diff', 'patch', 'ini', 'conf', 'cfg', 'properties',
		'proto', 'graphql', 'gql', 'ex', 'exs', 'gleam', 'erl', 'hrl', 'swift', 'm', 'mm',
		'r', 'lua', 'ps1', 'bat', 'dockerfile', 'makefile', 'gitignore', 'env'
	]);

	function supportedPromptAttachment(file: File): SelectedAttachment | null {
		const image = supportedPromptImage(file);
		if (image) return { id: '', file: image, name: image.name || 'Pasted image', kind: 'image', previewUrl: null };
		const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
		const specialName = file.name.toLowerCase();
		if (!promptFileExtensions.has(extension) && !['dockerfile', 'makefile', '.env', '.gitignore'].includes(specialName)) return null;
		return { id: '', file, name: file.name || 'Pasted file', kind: 'file', previewUrl: null };
	}

	function onAttachmentsSelected(e: Event) {
		const files = Array.from((e.currentTarget as HTMLInputElement).files ?? []);
		const accepted = files.map(supportedPromptAttachment).filter((item): item is SelectedAttachment => item !== null);
		if (accepted.length !== files.length) {
			showArchiveNotice({ tone: 'error', message: 'Supported attachments: PNG, JPEG, WebP, non-animated GIF, PDF, and common text/code files.' }, 5000);
		}
		addPromptAttachments(accepted);
		if (imageInputEl) imageInputEl.value = '';
	}

	function addPromptAttachments(items: SelectedAttachment[]) {
		selectedAttachments = [
			...selectedAttachments,
			...items.map((item) => {
				const name = item.name || `pasted-image-${Date.now()}.png`;
				return {
					...item,
					id: `${name}-${item.file.size}-${item.file.lastModified}-${Math.random()}`,
					name,
					previewUrl: item.kind === 'image' ? URL.createObjectURL(item.file) : null
				};
			})
		];
	}

	function onComposerPaste(event: ClipboardEvent) {
		const clipboardItems = Array.from(event.clipboardData?.items ?? [])
			.filter((item) => item.kind === 'file');
		const files = [
			...clipboardItems.map((item) => item.getAsFile()).filter((file): file is File => file !== null),
			...Array.from(event.clipboardData?.files ?? [])
		].filter((file, index, all) => all.findIndex((other) => other.name === file.name && other.size === file.size && other.type === file.type) === index);
		if (!files.length) return;
		const accepted = files.map(supportedPromptAttachment).filter((item): item is SelectedAttachment => item !== null);
		if (accepted.length !== files.length) {
			showArchiveNotice({ tone: 'error', message: 'That file type cannot be attached. Try a PDF, text/code file, or supported image.' }, 5000);
		}
		addPromptAttachments(accepted);
		if (accepted.length > 0 && !event.clipboardData?.getData('text/plain')) event.preventDefault();
	}

	function removeSelectedAttachment(id: string) {
		const removed = selectedAttachments.find((item) => item.id === id);
		if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
		selectedAttachments = selectedAttachments.filter((item) => item.id !== id);
	}

	async function openSessionInfo() {
		if (!sessionInfoDialog) return;
		sessionInfoDialog.showModal();
		await tick();
		sessionInfoDialog.focus();
	}

	function closeSessionInfoOnBackdrop(event: MouseEvent) {
		if (event.target === event.currentTarget) sessionInfoDialog?.close();
	}

	function reasoningText(item: any): string {
		if (item._reason) return item._reason;
		const s = item.summary;
		if (Array.isArray(s)) return s.map((x: any) => x?.text ?? '').join('\n');
		if (typeof s === 'string') return s;
		return '';
	}

	function shortLabel(s: ThreadSummary): string {
		if (s.name) return s.name;
		if (s.preview) return s.preview.slice(0, 48);
		return s.id.slice(0, 8);
	}

	function workspaceLabel(path: string | null | undefined): string {
		const normalized = path?.replace(/[\\/]+$/, '');
		return normalized?.split(/[\\/]/).pop() || 'Conversation';
	}

	function headerLabel(summary: ThreadSummary | null, id: string, cwd: string | undefined): string {
		if (summary?.name || summary?.preview) return shortLabel(summary);
		return cwd ? workspaceLabel(cwd) : id.slice(0, 8);
	}

	function isSideChat(s: ThreadSummary | null | undefined): boolean {
		return Boolean(s?.ephemeral);
	}

	function sideParentKey(sideId: string): string {
		return `yacwu:side:${sideId}`;
	}

	function sideChatsOf(parentId: string): ThreadSummary[] {
		return sessions.filter((s) => isSideChat(s) && s.forkedFromId === parentId);
	}

	function fileChangeKind(ch: any): string {
		const kind = ch?.kind;
		if (typeof kind === 'string' && kind.trim()) return kind;
		if (kind && typeof kind === 'object') {
			const label = kind.type ?? kind.kind ?? kind.action ?? kind.operation;
			if (typeof label === 'string' && label.trim()) return label;
			const keys = Object.keys(kind);
			if (keys.length === 1) return keys[0];
		}
		return 'changed';
	}

	function fileChangeClass(ch: any): string {
		return fileChangeKind(ch)
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/^-|-$/g, '') || 'changed';
	}

	function fileChangePath(ch: any): string {
		const path = ch?.path;
		if (typeof path === 'string') return path;
		if (path && typeof path === 'object' && typeof path.path === 'string') return path.path;
		return String(path ?? '');
	}

	function fileChangeSymbol(ch: any): string {
		const kind = fileChangeKind(ch).toLowerCase();
		if (kind.includes('add') || kind.includes('create')) return '+';
		if (kind.includes('delete') || kind.includes('remove')) return '−';
		return '~';
	}

	function toggleFilesPanel() {
		if (!activeId) return;
		if (filesOpen || changesOpen) {
			filesOpenBySession[activeId] = false;
			changesOpenBySession[activeId] = false;
			filesToggleEl?.focus();
		} else {
			filesOpenBySession[activeId] = true;
		}
	}

	function openFilesPanel() {
		if (!activeId) return;
		changesOpenBySession[activeId] = false;
		filesOpenBySession[activeId] = true;
	}

	function closeFilesPanel() {
		if (activeId) filesOpenBySession[activeId] = false;
		filesToggleEl?.focus();
	}

	/** Open the file browser at a session-relative path, optionally on a line. */
	function openFileInBrowser(rel: string, line: number | null = null, root: string | null = null) {
		if (!activeId) return;
		changesOpenBySession[activeId] = false;
		filesOpenBySession[activeId] = true;
		filesRevealBySession[activeId] = { path: rel, line, root, nonce: ++localCounter };
	}

	async function loadFileLinkPreview(path: string, root?: string | null) {
		if (!activeId) return;
		const id = activeId;
		fileLinkPreview = { path, content: 'Loading…' };
		try {
			const data = await readWorkspaceLink(id, path, sessionHost(id), fetch, root ?? undefined);
			if (activeId === id && fileLinkPreview?.path === path) fileLinkPreview = { path, content: data.content.slice(0, 2400) };
		} catch (error) {
			if (activeId === id && fileLinkPreview?.path === path) fileLinkPreview = { path, content: error instanceof Error ? error.message : 'Could not load file' };
		}
	}

	async function copyFileLinkContents(path: string, root?: string | null) {
		try {
			if (!activeId) throw new Error('No active session');
			const data = await readWorkspaceLink(activeId, path, sessionHost(activeId), fetch, root ?? undefined);
			if (!data.copyable) throw new Error('This file cannot be copied as text');
			await navigator.clipboard.writeText(data.content);
			copiedFileLink = path;
			setTimeout(() => { if (copiedFileLink === path) copiedFileLink = null; }, 1400);
		} catch (error) {
			showArchiveNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not copy file contents' }, 4500);
		}
	}

	function openChangesPanel(path: string | null = null) {
		if (!activeId) return;
		filesOpenBySession[activeId] = false;
		changesOpenBySession[activeId] = true;
		if (path) changesRevealBySession[activeId] = { path, nonce: ++localCounter };
	}

	function closeChangesPanel() {
		if (activeId) changesOpenBySession[activeId] = false;
		filesToggleEl?.focus();
	}

	/**
	 * The session-relative path (and optional line) to open when a code span
	 * in a Codex message looks like a workspace file, or null to leave it
	 * plain. Requires a directory separator so identifiers like
	 * `next.access_token` stay text; a `:line(:col)` suffix becomes the line
	 * to reveal; absolute paths must sit inside the session's working
	 * directory.
	 */
	function agentPathTarget(
		text: string,
		requireSeparator = true
	): { path: string; line: number | null; root: string | null } | null {
		if (!activeId) return null;
		let candidate = text.trim();
		try {
			candidate = decodeURIComponent(candidate);
		} catch {
			/* not URL-encoded — use as written */
		}
		let line: number | null = null;
		let root: string | null = null;
		const withLine = candidate.match(/^(.*?):(\d+)(?::\d+)?$/);
		if (withLine) {
			candidate = withLine[1];
			line = Number(withLine[2]) || null;
		}
		if (candidate.length > 1) candidate = candidate.replace(/\/+$/, '');
		if (candidate.startsWith('/')) {
			const rawCwd = cwds[activeId] ?? activeSummary?.cwd;
			const cwd = rawCwd?.replace(/[\\/]+$/, '') || '';
			if (!cwd) {
				const slash = candidate.lastIndexOf('/');
				root = slash <= 0 ? '/' : candidate.slice(0, slash);
				candidate = candidate.slice(slash + 1);
			} else {
			const normalizedCwd = cwd || '/';
			if (candidate === normalizedCwd) return { path: '', line: null, root: null };
			const prefix = normalizedCwd === '/' ? '/' : `${normalizedCwd}/`;
			if (candidate.startsWith(prefix)) candidate = candidate.slice(prefix.length);
			else {
				const slash = candidate.lastIndexOf('/');
				root = slash <= 0 ? '/' : candidate.slice(0, slash);
				candidate = candidate.slice(slash + 1);
			}
			}
		} else if (candidate.startsWith('./')) {
			candidate = candidate.slice(2);
		}
		// Markdown link hrefs may name a single file; bare code spans need a
		// separator so ordinary identifiers stay plain.
		const pattern = requireSeparator
			? /^[\w.@+-]+(?:\/[\w.@+-]+)+$/
			: /^[\w.@+-]+(?:\/[\w.@+-]+)*$/;
		if (!pattern.test(candidate)) return null;
		// The character class admits dots, so rule out ".."-style segments.
		if (candidate.split('/').some((segment) => /^\.+$/.test(segment))) return null;
		return { path: candidate, line, root };
	}

	function displayFileChangePath(ch: any): string {
		const path = fileChangePath(ch);
		const cwd = activeId ? (cwds[activeId] ?? activeSummary?.cwd) : null;
		return normalizeWorkspacePath(path, cwd ?? '');
	}

	async function refreshFileChangeLineStats(id: string) {
		const request = ++fileChangeStatsRequest;
		try {
			const res = await fetch(threadApi(id, '/git/changes?scope=all'));
			const data = await res.json();
			if (!res.ok || !Array.isArray(data.files)) return;
			if (request !== fileChangeStatsRequest || id !== activeId) return;
			const cwd = cwds[id] ?? sessions.find((session) => session.id === id)?.cwd ?? '';
			fileChangeLineStats = indexFileLineStats(data.files, cwd);
		} catch {
			// Keep transcript rendering available if Git stats cannot be read.
		}
	}

	function fileChangeStats(ch: any) {
		const cwd = activeId ? (cwds[activeId] ?? activeSummary?.cwd ?? '') : '';
		return lineStatsForPath(fileChangeLineStats, fileChangePath(ch), cwd);
	}

	$effect(() => {
		const id = activeId;
		filesRefresh;
		if (id) untrack(() => {
			fileChangeLineStats = {};
			void refreshFileChangeLineStats(id);
		});
		else {
			fileChangeStatsRequest += 1;
			fileChangeLineStats = {};
		}
	});

	function displayCommand(command: unknown): string {
		const text = String(command ?? '');
		const wrapped = text.match(/^(?:\/bin\/)?(?:ba|z|fi)?sh\s+-lc\s+([\s\S]+)$/);
		if (!wrapped) return text;
		const body = wrapped[1].trim();
		const quote = body[0];
		return (quote === '"' || quote === "'") && body.endsWith(quote) ? body.slice(1, -1) : body;
	}

	function commandStatusLabel(item: any): string {
		if (item.status === 'completed') {
			return item.exitCode === undefined || item.exitCode === null
				? 'Completed'
				: `Completed with exit code ${item.exitCode}`;
		}
		if (item.status === 'failed') {
			return item.exitCode === undefined || item.exitCode === null
				? 'Failed'
				: `Failed with exit code ${item.exitCode}`;
		}
		return 'In progress';
	}

	function currentWorkDescription(items: ThreadItem[]): string {
		let latestUserIndex = 0;
		for (let i = items.length - 1; i >= 0; i -= 1) {
			if (items[i].type === 'userMessage') {
				latestUserIndex = i;
				break;
			}
		}

		for (let i = items.length - 1; i >= 0; i -= 1) {
			if (i < latestUserIndex) break;
			const item = items[i] as any;
			if (item.type === 'commandExecution' && item.status === 'inProgress') {
				return `Running ${truncateText(displayCommand(item.command), 120)}`;
			}
			if (item.type === 'collabAgentToolCall' && item.status === 'inProgress') {
				return `Delegating: ${truncateText(collabSummary(item), 110)}`;
			}
			if (item.type === 'mcpToolCall' && item.status === 'inProgress') {
				if (item.tool === 'YacwuBackgroundWorker') return 'Background worker running';
				return `Using ${truncateText(mcpActivityLabel(item), 120)}`;
			}
			if (item.type === 'dynamicToolCall' && item.status === 'inProgress') {
				return `Using ${truncateText(String(item.tool || 'an app tool'), 120)}`;
			}
			if (item.type === 'fileChange' && item.status === 'inProgress') {
				const paths = (item.changes ?? []).map((change: any) => displayFileChangePath(change)).filter(Boolean);
				const detail = paths.length > 1 ? `${paths[0]} and ${paths.length - 1} more` : paths[0];
				return `Editing${detail ? ` ${truncateText(detail, 110)}` : ' files'}`;
			}
			if (item.type === 'plan' && Array.isArray(item.plan)) {
				const step = [...item.plan].reverse().find((entry: any) => entry.status === 'inProgress');
				if (step?.step) return `Plan step: ${truncateText(step.step, 120)}`;
			}
			if (item.type === 'webSearch') {
				const search = webSearchPresentation(item);
				return truncateText([search.label, search.detail].filter(Boolean).join(' '), 140);
			}
			if (item.type === 'agentMessage' && item.phase === 'commentary' && item.text?.trim()) {
				return truncateText(item.text.trim(), 140);
			}
		}
		return 'No concrete activity update yet';
	}

	function commandOutput(item: any): string {
		return String(item._out || item.aggregatedOutput || '');
	}

	function commandOutputLineCount(output: string): number {
		if (!output) return 0;
		return output.endsWith('\n') ? output.slice(0, -1).split('\n').length : output.split('\n').length;
	}

	function commandOutputIsLong(output: string): boolean {
		return commandOutputLineCount(output) > settings.collapseOutputLines || output.length > COMMAND_OUTPUT_COLLAPSE_CHARS;
	}

	function agentRawKey(item: any): string {
		return `${viewedId ?? 'none'}:${String(item.id ?? '')}`;
	}

	function toggleAgentRaw(item: any) {
		const key = agentRawKey(item);
		agentRawShown[key] = !agentRawShown[key];
	}

	async function copyAgentResponse(item: any) {
		const key = agentRawKey(item);
		try {
			await navigator.clipboard.writeText(stripTaskProgressMarkers(String(item.text ?? '')));
			agentCopyStatus[key] = 'copied';
		} catch {
			agentCopyStatus[key] = 'failed';
		}
		if (agentCopyTimer) clearTimeout(agentCopyTimer);
		agentCopyTimer = setTimeout(() => {
			delete agentCopyStatus[key];
			agentCopyTimer = null;
		}, 1800);
	}

	function responseFileTargets(item: any) {
		const seen = new Set<string>();
		return markdownFileReferences(stripTaskProgressMarkers(String(item.text ?? ''))).flatMap((reference) => {
			const target = agentPathTarget(reference.text, reference.requireSeparator);
			if (!target) return [];
			const key = JSON.stringify([target.root, target.path]);
			if (seen.has(key)) return [];
			seen.add(key);
			return [target];
		});
	}

	async function copyResponseFiles(item: any) {
		const id = activeId;
		const key = agentRawKey(item);
		if (!id || agentFileCopyStatus[key] === 'copying') return;
		const targets = responseFileTargets(item);
		const host = sessionHost(id);
		agentFileCopyStatus[key] = 'copying';
		try {
			const sections: string[] = [];
			for (const target of targets) {
				const filename = target.root ? `${target.root.replace(/\/$/, '')}/${target.path}` : target.path;
				try {
					const data = await readWorkspaceLink(id, target.path, host, fetch, target.root ?? undefined);
					if (data.directory) continue;
					if (!data.copyable) throw new Error('Cannot copy this file as text');
					sections.push(`## ${filename}\n\n${data.content}`);
				} catch (error) {
					throw new Error(`${filename}: ${error instanceof Error ? error.message : 'Could not read file'}`);
				}
			}
			if (!sections.length) throw new Error('No linked text files to copy. Directory links are skipped.');
			await navigator.clipboard.writeText(sections.join('\n\n'));
			agentFileCopyStatus[key] = 'copied';
		} catch (error) {
			agentFileCopyStatus[key] = 'failed';
			showArchiveNotice({ tone: 'error', message: error instanceof Error ? error.message : 'Could not copy linked files' }, 6000);
		}
		setTimeout(() => { delete agentFileCopyStatus[key]; }, 2000);
	}

	function agentTime(item: any): { label: string; iso: string; full: string } | null {
		const at = (item as any)._at;
		if (typeof at !== 'number') return null;
		const date = new Date(at);
		return {
			label: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
			iso: date.toISOString(),
			full: date.toLocaleString()
		};
	}

	function onAgentMessageTap(item: any) {
		if (hoverPointer) return;
		tappedAgentKey = agentRawKey(item);
	}

	function onWindowClick(e: MouseEvent) {
		const target = e.target as Element | null;
		if (hoverPointer || tappedAgentKey === null) return;
		if (!target?.closest?.('.item.agent')) tappedAgentKey = null;
	}

	function commandOutputStateKey(item: any): string {
		return `${viewedId ?? 'none'}:${String(item.id ?? '')}`;
	}

	function commandOutputIsExpanded(item: any, output: string): boolean {
		const saved = commandOutputExpanded[commandOutputStateKey(item)];
		if (saved !== undefined) return saved;
		return item.status === 'inProgress' || !commandOutputIsLong(output);
	}

	function toggleCommandOutput(item: any, output: string) {
		const key = commandOutputStateKey(item);
		commandOutputExpanded[key] = !commandOutputIsExpanded(item, output);
	}

	function commandOutputId(item: any): string {
		return `command-output-${commandOutputStateKey(item).replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
	}

	function commandOutputCountLabel(output: string): string {
		const lines = commandOutputLineCount(output);
		if (lines === 1 && output.length > COMMAND_OUTPUT_COLLAPSE_CHARS) return `${output.length} chars`;
		return `${lines} ${lines === 1 ? 'line' : 'lines'}`;
	}

	function safeWebUrl(value: unknown): string | null {
		if (typeof value !== 'string' || !value) return null;
		try {
			const url = new URL(value);
			return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
		} catch {
			return null;
		}
	}

	function webSearchPresentation(item: any): {
		label: string;
		detail: string;
		href: string | null;
		resultCount: number;
	} {
		const action = item.action;
		const resultCount = Array.isArray(item.results) ? item.results.length : 0;
		if (!action) {
			return {
				label: 'Searching the web',
				detail: item.query || '',
				href: null,
				resultCount
			};
		}
		switch (action.type) {
			case 'search': {
				const detail =
					action.query ||
					(Array.isArray(action.queries) ? action.queries.filter(Boolean).join(', ') : '') ||
					item.query ||
					'';
				return { label: 'Searched the web for', detail, href: null, resultCount };
			}
			case 'openPage': {
				const detail = action.url || item.query || '';
				return { label: 'Opened', detail, href: safeWebUrl(action.url), resultCount };
			}
			case 'findInPage': {
				const pattern = action.pattern ? `“${action.pattern}”` : '';
				const url = action.url || '';
				return {
					label: 'Searched in page for',
					detail: [pattern, url].filter(Boolean).join(' · ') || item.query || '',
					href: null,
					resultCount
				};
			}
			default:
				return { label: 'Used web search', detail: item.query || '', href: null, resultCount };
		}
	}

	function subAgentActivityParts(item: any): { prefix: string; path: string } {
		const path = item.agentPath ?? item.agentThreadId ?? 'agent';
		switch (item.kind) {
			case 'started':
				return { prefix: 'Started', path };
			case 'interacted':
				return { prefix: 'Interacted with', path };
			case 'interrupted':
				return { prefix: 'Interrupted', path };
			default:
				return { prefix: 'Sub-agent activity:', path };
		}
	}

	function openAgentActivity(item: any) {
		const agentId = typeof item?.agentThreadId === 'string' ? item.agentThreadId : null;
		if (!agentId || !activeId || agentId === activeId) return;
		const knownAgent = agents[agentId];
		if (!knownAgent) {
			trackAgentItem(agents, activeId, item);
		}
		goto(agentHref(agentId));
	}

	function truncateText(text: string, max: number): string {
		return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
	}

	// Summaries mirror the Codex TUI's collab tool-call rows.
	function collabSummary(item: any): string {
		const receivers: string[] = item.receiverThreadIds ?? [];
		const target = receivers[0] ? receivers[0].slice(0, 8) : null;
		const inProgress = item.status === 'inProgress';
		switch (item.tool) {
			case 'spawnAgent':
				if (inProgress) return 'Spawning agent…';
				return target ? `Spawned agent ${target}` : 'Agent spawn failed';
			case 'sendInput':
				return `${inProgress ? 'Sending input to' : 'Sent input to'} ${target ?? 'agent'}`;
			case 'resumeAgent':
				return `${inProgress ? 'Resuming' : 'Resumed'} ${target ?? 'agent'}`;
			case 'wait':
				if (inProgress) {
					return receivers.length > 1
						? `Waiting for ${receivers.length} agents…`
						: `Waiting for ${target ?? 'agents'}…`;
				}
				return 'Finished waiting';
			case 'closeAgent':
				return `${inProgress ? 'Closing' : 'Closed'} ${target ?? 'agent'}`;
			default:
				return `agent tool: ${item.tool ?? 'unknown'}`;
		}
	}

	function collabAgentStates(item: any): Array<{ id: string; status: string; message: string | null }> {
		const states = item.agentsStates ?? {};
		return Object.entries(states).map(([id, state]: [string, any]) => ({
			id: id.slice(0, 8),
			status: state?.status ?? 'unknown',
			message: state?.message ?? null
		}));
	}

	function applyTheme(next: 'light' | 'dark', persist = true) {
		theme = next;
		document.documentElement.dataset.theme = next;
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute('content', next === 'dark' ? '#25221f' : '#faf8f1');
		if (persist) localStorage.setItem('yacwu-theme', next);
	}

	function tooltipTargetFrom(target: EventTarget | null): Element | null {
		return target instanceof Element ? target.closest('[data-yacwu-tooltip], [title]') : null;
	}

	function storeAndRemoveTitle(element: Element, title: string) {
		if (title.trim()) element.setAttribute('data-yacwu-tooltip', title);
		else element.removeAttribute('data-yacwu-tooltip');
		internallyRemovedTitles.add(element);
		element.removeAttribute('title');
		window.setTimeout(() => internallyRemovedTitles.delete(element), 0);
	}

	function showInstantTooltip(target: Element | null) {
		if (!target) return;
		if (instantTooltipTarget && instantTooltipTarget !== target) hideInstantTooltip();
		const nativeTitle = target.getAttribute('title');
		const text = target.getAttribute('data-yacwu-tooltip') ?? nativeTitle;
		if (!text?.trim()) return;
		if (nativeTitle !== null) {
			storeAndRemoveTitle(target, nativeTitle);
		}
		instantTooltipTarget = target;
		const rect = target.getBoundingClientRect();
		const wide = Boolean(target.closest('.session-label'));
		const width = Math.min(wide ? 560 : 288, window.innerWidth - 16);
		const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
		const below = rect.bottom + 10;
		const maxHeight = wide ? Math.min(window.innerHeight * 0.6, 448) : 90;
		const top = below + maxHeight < window.innerHeight
			? below
			: Math.max(8, rect.top - (wide ? Math.min(maxHeight, 240) : 52));
		const describedBy = new Set((target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
		describedBy.add('yacwu-instant-tooltip');
		target.setAttribute('aria-describedby', [...describedBy].join(' '));
		instantTooltip = { text, left, top, wide };
	}

	function hideInstantTooltip(target?: Element | null) {
		if (!instantTooltipTarget || (target && target !== instantTooltipTarget)) return;
		const describedBy = (instantTooltipTarget.getAttribute('aria-describedby') ?? '')
			.split(/\s+/).filter((id) => id && id !== 'yacwu-instant-tooltip');
		if (describedBy.length) instantTooltipTarget.setAttribute('aria-describedby', describedBy.join(' '));
		else instantTooltipTarget.removeAttribute('aria-describedby');
		instantTooltipTarget = null;
		instantTooltip = null;
	}

	function onTooltipPointerOver(event: PointerEvent) {
		if (event.pointerType === 'touch') return;
		const target = tooltipTargetFrom(event.target);
		if (target && target !== instantTooltipTarget) showInstantTooltip(target);
	}

	function onTooltipPointerOut(event: PointerEvent) {
		const from = tooltipTargetFrom(event.target);
		const to = tooltipTargetFrom(event.relatedTarget);
		if (from === instantTooltipTarget && to !== from) hideInstantTooltip(from);
	}

	function onTooltipFocusIn(event: FocusEvent) {
		showInstantTooltip(tooltipTargetFrom(event.target));
	}

	function onTooltipFocusOut(event: FocusEvent) {
		const from = tooltipTargetFrom(event.target);
		const to = tooltipTargetFrom(event.relatedTarget);
		if (from === instantTooltipTarget && to !== from) hideInstantTooltip(from);
	}

	function dismissTooltipOnViewportChange() {
		hideInstantTooltip();
	}

	function toggleTheme() {
		applyTheme(theme === 'dark' ? 'light' : 'dark');
	}

	/** Session rules for sessions without saved ones come from the global settings. */
	function ruleDefaults(): SessionRules {
		return { ...defaultSessionRules, progress: settings.defaultProgressReporting, sharedChannel: settings.defaultSharedCoordination };
	}

	function rulesFor(id: string): SessionRules {
		return sessionRules[id] ?? ruleDefaults();
	}

	function saveSettings(next: GlobalSettings) {
		if (next.showAllActivity !== settings.showAllActivity) showAllActivity = next.showAllActivity;
		settings = next;
		try { localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(next)); } catch { /* Applies for this page only. */ }
	}

	function closeSettingsOnBackdrop(event: MouseEvent) {
		if (event.target === event.currentTarget) settingsDialog?.close();
	}

	onMount(() => {
		void loadHostChoices();
		applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', false);
		const transferTitle = (element: Element) => {
			const title = element.getAttribute('title');
			if (title !== null) {
				storeAndRemoveTitle(element, title);
			} else if (!internallyRemovedTitles.has(element)) {
				element.removeAttribute('data-yacwu-tooltip');
			}
		};
		const transferTitleTree = (root: ParentNode) => {
			if (root instanceof Element) transferTitle(root);
			root.querySelectorAll('[title]').forEach(transferTitle);
		};
		transferTitleTree(document);
		const tooltipObserver = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === 'attributes' && record.target instanceof Element) transferTitle(record.target);
				for (const node of record.addedNodes) if (node instanceof Element) transferTitleTree(node);
			}
		});
		tooltipObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['title'],
			childList: true,
			subtree: true
		});
		window.addEventListener('pointerover', onTooltipPointerOver);
		window.addEventListener('pointerout', onTooltipPointerOut);
		window.addEventListener('focusin', onTooltipFocusIn);
		window.addEventListener('focusout', onTooltipFocusOut);
		window.addEventListener('scroll', dismissTooltipOnViewportChange, true);
		window.addEventListener('resize', dismissTooltipOnViewportChange);
		try {
			const savedTodos = JSON.parse(localStorage.getItem(TODO_QUEUES_KEY) ?? '{}');
			if (savedTodos && typeof savedTodos === 'object' && !Array.isArray(savedTodos)) {
				todoQueues = Object.fromEntries(Object.entries(savedTodos).flatMap(([id, value]) => {
					if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
					const queue = value as Partial<TodoQueue>;
					if (!Array.isArray(queue.tasks) || !queue.tasks.every((task) => typeof task === 'string')) return [];
					const startedCount = Number(queue.startedCount);
					if (!Number.isInteger(startedCount) || startedCount < 0 || startedCount > queue.tasks.length) return [];
					if (queue.currentTask !== null && typeof queue.currentTask !== 'string') return [];
					return [[id, { tasks: queue.tasks, startedCount, currentTask: queue.currentTask ?? null, initialTask: typeof queue.initialTask === 'string' ? queue.initialTask : null }]];
				}));
			}
		} catch {
			todoQueues = {};
		}
		try {
			const savedFinished = JSON.parse(localStorage.getItem(FINISHED_SESSIONS_KEY) ?? '{}');
			if (savedFinished && typeof savedFinished === 'object' && !Array.isArray(savedFinished)) {
				finishedSessions = Object.fromEntries(
					Object.entries(savedFinished).filter((entry): entry is [string, boolean] => entry[1] === true)
				);
			}
		} catch {
			finishedSessions = {};
		}
		try {
			const savedAttention = JSON.parse(localStorage.getItem(DISMISSED_ATTENTION_KEY) ?? '{}');
			if (savedAttention && typeof savedAttention === 'object' && !Array.isArray(savedAttention)) {
				dismissedAttentionByThread = Object.fromEntries(
					Object.entries(savedAttention).filter((entry): entry is [string, boolean] => entry[1] === true)
				);
			}
		} catch {
			dismissedAttentionByThread = {};
		}
		try {
			const savedQuestions = JSON.parse(localStorage.getItem(RESOLVED_QUESTIONS_KEY) ?? '{}');
			if (savedQuestions && typeof savedQuestions === 'object' && !Array.isArray(savedQuestions)) {
				resolvedInteractiveQuestionIds = Object.fromEntries(Object.entries(savedQuestions).filter((entry): entry is [string, boolean] => entry[1] === true));
			}
		} catch {
			resolvedInteractiveQuestionIds = {};
		}
		if (activeId) {
			clearFinishedSession(activeId);
			markSessionAttentionRead(activeId);
		}
		try {
			const savedOrder = JSON.parse(localStorage.getItem(SESSION_ORDER_KEY) ?? '[]');
			if (Array.isArray(savedOrder)) sessionOrder = savedOrder.filter((id): id is string => typeof id === 'string');
		} catch {
			sessionOrder = [];
		}
		const savedSplit = Number(localStorage.getItem(WORKSPACE_SPLIT_KEY));
		if (Number.isFinite(savedSplit) && savedSplit >= 0.2 && savedSplit <= 0.7) workspaceSplitRatio = savedSplit;
		try {
			const savedDismissedGoals = JSON.parse(localStorage.getItem(DISMISSED_GOALS_KEY) ?? '{}');
			if (savedDismissedGoals && typeof savedDismissedGoals === 'object' && !Array.isArray(savedDismissedGoals)) {
				dismissedGoalBySession = Object.fromEntries(
					Object.entries(savedDismissedGoals).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
				);
			}
		} catch {
			dismissedGoalBySession = {};
		}
		const mobileQuery = window.matchMedia('(max-width: 59.999rem)');
		const updateMobileViewport = () => {
			mobileViewport = mobileQuery.matches;
			if (!mobileViewport) mobileSidebarOpen = false;
		};
		const hoverQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
		const updateHoverPointer = () => {
			hoverPointer = hoverQuery.matches;
			if (hoverPointer) tappedAgentKey = null;
		};
		updateHoverPointer();
		hoverQuery.addEventListener('change', updateHoverPointer);
		desktopSidebarHidden = localStorage.getItem('yacwu-sidebar-hidden') === 'true';
		try {
			const savedFastSessions = JSON.parse(localStorage.getItem(FAST_SESSIONS_KEY) ?? '[]');
			if (Array.isArray(savedFastSessions)) {
				fastSessions = Object.fromEntries(
					savedFastSessions.filter((id): id is string => typeof id === 'string').map((id) => [id, true])
				);
			}
		} catch {
			fastSessions = {};
		}
		updateMobileViewport();
		mobileQuery.addEventListener('change', updateMobileViewport);

		void reconcileInterruptedSessions().finally(() => (startupRecoveryComplete = true));
		try { sessionRules = readSessionRules(localStorage.getItem(SESSION_RULES_KEY)); } catch { /* Defaults if storage is disabled. */ }
		try {
			settings = readSettings(localStorage.getItem(GLOBAL_SETTINGS_KEY));
			showAllActivity = settings.showAllActivity;
		} catch { /* Defaults if storage is disabled. */ }
		const runtimeCheckTimer = setInterval(() => void reconcileInterruptedSessions(), 15000);
		loadSessions();
		const accountUsageTimer = setInterval(() => {
			if (activeId) void loadAccountUsage(activeHost, true);
		}, 5 * 60 * 1000);
		const es = new EventSource('/api/events');
		es.onopen = () => {
			connected = true;
			if (activeId) reportDiagnostics(activeId, 'sse_connected');
		};
		es.onerror = () => {
			const wasConnected = connected;
			connected = false;
			if (wasConnected && activeId) reportDiagnostics(activeId, 'sse_disconnected');
		};
		es.onmessage = (e) => {
			try {
				const msg = JSON.parse(e.data) as JsonRpcNotification;
				if (msg.method === 'yacwu/connected') {
					connected = true;
					void reconcileInterruptedSessions();
					if (activeId) void loadRelayLog(activeId);
					return;
				}
				handleNotification(msg);
			} catch {
				/* ignore */
			}
		};
		return () => {
			es.close();
			tooltipObserver.disconnect();
			window.removeEventListener('pointerover', onTooltipPointerOver);
			window.removeEventListener('pointerout', onTooltipPointerOut);
			window.removeEventListener('focusin', onTooltipFocusIn);
			window.removeEventListener('focusout', onTooltipFocusOut);
			window.removeEventListener('scroll', dismissTooltipOnViewportChange, true);
			window.removeEventListener('resize', dismissTooltipOnViewportChange);
			clearInterval(accountUsageTimer);
			clearInterval(runtimeCheckTimer);
			for (const timer of usageRefreshTimers.values()) clearTimeout(timer);
			usageRefreshTimers.clear();
			if (archiveNoticeTimer) clearTimeout(archiveNoticeTimer);
			if (agentCopyTimer) clearTimeout(agentCopyTimer);
			mobileQuery.removeEventListener('change', updateMobileViewport);
			hoverQuery.removeEventListener('change', updateHoverPointer);
		};
	});
</script>

<svelte:window onkeydown={onWindowKeydown} onclick={onWindowClick} />

<dialog class="session-info-dialog" bind:this={settingsDialog} aria-labelledby="global-settings-title" tabindex="-1" onclick={closeSettingsOnBackdrop} onclose={() => (settingsOpen = false)}>
	<div class="session-info-panel">
		<div class="session-info-heading">
			<h2 id="global-settings-title">Settings</h2>
			<button class="session-info-close" type="button" onclick={() => settingsDialog?.close()} aria-label="Close settings" title="Close">
				<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
					<path d="M6 6l12 12M18 6 6 18" />
				</svg>
			</button>
		</div>
		{#if settingsOpen}
			<GlobalSettingsForm {settings} {theme} onchange={saveSettings} onthemechange={(next) => applyTheme(next)} />
		{/if}
	</div>
</dialog>

{#snippet themeToggle(className = '')}
	<button
		class={`theme-toggle ${className}`}
		type="button"
		onclick={toggleTheme}
		aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
		title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
	>
		{#if theme === 'dark'}
			<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
				<circle cx="12" cy="12" r="4" />
				<path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
			</svg>
		{:else}
			<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
				<path d="M20.25 15.3A8.5 8.5 0 0 1 8.7 3.75 8.5 8.5 0 1 0 20.25 15.3Z" />
			</svg>
		{/if}
	</button>
{/snippet}

{#snippet fastMark()}
	<span class="fast-mark" role="img" aria-label="Fast mode enabled" title="Fast mode enabled">
		<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			<path d="M9.1 1.5 3.7 8.7h3.6L6.8 14.5l5.5-7.4H8.7z" />
		</svg>
	</span>
{/snippet}

{#snippet commandResult(item: any)}
	<span
		class="cmd-result {item.status}"
		role="img"
		aria-label={commandStatusLabel(item)}
		title={commandStatusLabel(item)}
	>
		{#if item.status === 'completed'}
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>
		{:else if item.status === 'failed'}
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
		{:else}
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h3l2-4 3 8 2-4h2" /></svg>
		{/if}
	</span>
{/snippet}

{#snippet markdownInlines(tokens: MarkdownInline[])}
	{#each tokens as token}
		{#if token.type === 'text'}
			{token.text}
		{:else if token.type === 'strong'}
			<strong>{@render markdownInlines(token.children)}</strong>
		{:else if token.type === 'em'}
			<em>{@render markdownInlines(token.children)}</em>
		{:else if token.type === 'del'}
			<del>{@render markdownInlines(token.children)}</del>
		{:else if token.type === 'code'}
			{@const pathTarget = agentPathTarget(token.text)}
			{#if pathTarget !== null}
				<span class="file-link-actions" role="group" onmouseenter={() => void loadFileLinkPreview(pathTarget.path, pathTarget.root)} onmouseleave={() => fileLinkPreview?.path === pathTarget.path && (fileLinkPreview = null)}>
					<button type="button" class="code-path" title={pathTarget.line ? `Open in file browser at line ${pathTarget.line}` : 'Open in file browser'} onclick={() => openFileInBrowser(pathTarget.path, pathTarget.line, pathTarget.root)}><code>{token.text}</code></button>
					<button type="button" class="file-link-copy" aria-label={`Copy ${pathTarget.path}`} title={copiedFileLink === pathTarget.path ? 'Copied' : 'Copy file contents or folder listing'} onclick={() => void copyFileLinkContents(pathTarget.path, pathTarget.root)}>{copiedFileLink === pathTarget.path ? '✓' : '⧉'}</button>
					{#if fileLinkPreview?.path === pathTarget.path}<span class="file-link-preview"><strong>{pathTarget.path}</strong><pre>{fileLinkPreview.content}</pre></span>{/if}
				</span>
			{:else}
				<code>{token.text}</code>
			{/if}
		{:else if token.type === 'break'}
			<br />
		{:else if token.type === 'link'}
			{#if token.href}
				{@const fileTarget = token.external ? null : agentPathTarget(token.href, false)}
				{#if fileTarget !== null}
					<span class="file-link-actions" role="group" onmouseenter={() => void loadFileLinkPreview(fileTarget.path, fileTarget.root)} onmouseleave={() => fileLinkPreview?.path === fileTarget.path && (fileLinkPreview = null)}>
						<button type="button" class="link-path" title={fileTarget.line ? `Open ${fileTarget.path} at line ${fileTarget.line}` : `Open ${fileTarget.path} in file browser`} onclick={() => openFileInBrowser(fileTarget.path, fileTarget.line, fileTarget.root)}>{@render markdownInlines(token.children)}</button>
						<button type="button" class="file-link-copy" aria-label={`Copy ${fileTarget.path}`} title={copiedFileLink === fileTarget.path ? 'Copied' : 'Copy file contents or folder listing'} onclick={() => void copyFileLinkContents(fileTarget.path, fileTarget.root)}>{copiedFileLink === fileTarget.path ? '✓' : '⧉'}</button>
						{#if fileLinkPreview?.path === fileTarget.path}<span class="file-link-preview"><strong>{fileTarget.path}</strong><pre>{fileLinkPreview.content}</pre></span>{/if}
					</span>
				{:else}
					<a
						href={token.href}
						title={token.title ?? undefined}
						target={token.external ? '_blank' : undefined}
						rel={token.external ? 'noreferrer noopener' : undefined}
					>{@render markdownInlines(token.children)}</a>
				{/if}
			{:else}
				{@render markdownInlines(token.children)}
			{/if}
		{:else if token.type === 'image'}
			{@const src = token.src ? markdownImageSrc(token.src) : null}
			{#if src}
				<img class="markdown-image" src={src} alt={token.alt} title={token.title ?? undefined} loading="lazy" />
			{:else}
				<span>{token.alt}</span>
			{/if}
		{/if}
	{/each}
{/snippet}

{#snippet markdownBlocks(blocks: MarkdownBlock[])}
	{#each blocks as block}
		{#if block.type === 'paragraph'}
			<p>{@render markdownInlines(block.children)}</p>
		{:else if block.type === 'heading'}
			<div class="markdown-heading" role="heading" aria-level={Math.min(block.depth, 6)}>
				<span class="markdown-hash" aria-hidden="true">{'#'.repeat(Math.min(block.depth, 6))}</span>
				<strong>{@render markdownInlines(block.children)}</strong>
			</div>
		{:else if block.type === 'code'}
			<div class="markdown-code">
				{#if block.language}<span class="markdown-language">{block.language}</span>{/if}
				<pre><code>{block.text}</code></pre>
			</div>
		{:else if block.type === 'blockquote'}
			<blockquote>{@render markdownBlocks(block.children)}</blockquote>
		{:else if block.type === 'list'}
			{#if block.ordered}
				<ol start={block.start ?? 1}>
					{#each block.items as item}
						<li class:task={item.checked !== null}>
							{#if item.checked !== null}<input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Completed' : 'Not completed'} />{/if}
							{@render markdownBlocks(item.children)}
						</li>
					{/each}
				</ol>
			{:else}
				<ul>
					{#each block.items as item}
						<li class:task={item.checked !== null}>
							{#if item.checked !== null}<input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Completed' : 'Not completed'} />{/if}
							{@render markdownBlocks(item.children)}
						</li>
					{/each}
				</ul>
			{/if}
		{:else if block.type === 'table'}
			<div class="markdown-table-wrap">
				<table>
					<thead>
						<tr>
							{#each block.header as cell}
								<th class:align-center={cell.align === 'center'} class:align-right={cell.align === 'right'}>{@render markdownInlines(cell.children)}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each block.rows as row}
							<tr>
								{#each row as cell}
									<td class:align-center={cell.align === 'center'} class:align-right={cell.align === 'right'}>{@render markdownInlines(cell.children)}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if block.type === 'rule'}
			<hr />
		{/if}
	{/each}
{/snippet}

<div class="app" class:sidebar-open={mobileSidebarOpen} class:rail-hidden={desktopSidebarHidden}>
	{#if !activeId && !mobileSidebarOpen}
		<button
			class="sidebar-toggle welcome-menu"
			bind:this={sidebarToggleEl}
			aria-controls="session-sidebar"
			aria-label={sessionRailToggleLabel}
			aria-expanded={sessionRailOpen}
			onclick={toggleSidebar}
		>
			<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
				{#if mobileSidebarOpen}
					<path d="M6 6l12 12M18 6 6 18" />
				{:else if !mobileViewport}
					<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
					<path d="M9 5v14M12 9l3 3-3 3" />
				{:else}
					<path d="M4 7h16M4 12h16M4 17h16" />
				{/if}
			</svg>
		</button>
		{@render themeToggle('welcome-theme')}
	{/if}
	<button
		class="sidebar-scrim"
		aria-label="Close sessions"
		aria-hidden={!mobileSidebarOpen}
		disabled={!mobileSidebarOpen}
		onclick={() => closeSidebar()}
	></button>

	<aside
		id="session-sidebar"
		class="sidebar"
		class:open={mobileSidebarOpen}
		bind:this={sidebarEl}
		inert={(mobileViewport && !mobileSidebarOpen) || (!mobileViewport && desktopSidebarHidden)}
	>
		<div class="brand">
			<a class="brand-identity" href="/" aria-label="Yacwu home">
				<img src="/yacwu-icon.svg" alt="" width="32" height="32" />
				<span>Yacwu</span>
			</a>
			<button
				class="drawer-close"
				type="button"
				onclick={toggleSidebar}
				aria-controls="session-sidebar"
				aria-expanded={sessionRailOpen}
				aria-label={sessionRailToggleLabel}
				title={sessionRailToggleLabel}
			>
				<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
					{#if mobileViewport}
						<path d="M6 6l12 12M18 6 6 18" />
					{:else}
						<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
						<path d="M9 5v14M15 9l-3 3 3 3" />
					{/if}
				</svg>
			</button>
			<span class="connection" title={connected ? 'Connected to Codex' : 'Disconnected from Codex'}>
				<span class="dot" class:on={connected}></span>
				<span>{connected ? 'Online' : 'Offline'}</span>
			</span>
		</div>
		{#if creating}
			<div class="create" role="group" aria-labelledby="create-title">
				<div class="create-heading">
					<h2 id="create-title">Start a session</h2>
					<button class="mini ghost" onclick={cancelCreating}>Cancel</button>
				</div>
				{#if machineChoices.length > 0}
					<div class="create-row">
						<label for="new-host">Machine</label>
						<select id="new-host" class="profile-input" bind:value={newMachine} onchange={onNewHostChange}>
							{#each machineChoices as h (h.name)}
								<option value={h.name}>
									{h.name === LOCAL_HOST ? 'This machine' : h.name}{h.kind === 'remote' &&
									(hostStates[h.name] ?? h.state) !== 'disconnected'
										? ` · ${hostStates[h.name] ?? h.state}`
										: ''}
								</option>
							{/each}
						</select>
					</div>
				{/if}
				{#if claudeHost}
					<div class="create-row">
						<label for="new-provider">Provider</label>
						<select id="new-provider" class="profile-input" bind:value={newProvider} onchange={onNewHostChange}>
							<option value="codex">Codex</option>
							<option value="claude" disabled={newMachine !== LOCAL_HOST}>Claude</option>
						</select>
					</div>
				{/if}
				<div class="create-row">
					<label for="new-cwd">Working directory</label>
					<div class="cwd-field">
						<input
							id="new-cwd"
							class="cwd-input"
							bind:this={cwdInputEl}
							bind:value={newCwd}
							onkeydown={onCwdKeydown}
							placeholder={(isRemoteHost(newHost) ? hostDefaultCwds[newHost] : defaultCwd) ||
								'/path/to/project'}
							aria-invalid={Boolean(createError)}
							aria-describedby="create-helper"
							spellcheck="false"
							autocapitalize="off"
							autocomplete="off"
						/>
						<button class="cwd-browse-trigger" type="button" onclick={() => browseDirectories()} aria-expanded={cwdBrowseOpen} aria-controls="cwd-browser">
							<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" /></svg>
							Browse
						</button>
					</div>
				</div>
				{#if cwdBrowseOpen}
					<div class="cwd-browser" id="cwd-browser" aria-label="Choose working directory">
		<div class="cwd-browser-toolbar">
							<button class="cwd-up" type="button" onclick={() => browseDirectories(directoryParent(cwdBrowsePath))} disabled={!cwdBrowsePath || directoryParent(cwdBrowsePath) === cwdBrowsePath} aria-label="Go to parent folder" title="Parent folder">↑</button>
							<button
								class="cwd-current"
								type="button"
								title="Use this folder"
								aria-label={`Use folder ${cwdBrowsePath || 'current directory'}`}
								disabled={!cwdBrowsePath || cwdBrowseLoading}
								onclick={() => selectBrowseDirectory()}
							>{cwdBrowsePath || 'Choose a folder'}</button>
		</div>
		<label class="cwd-hidden-toggle">
			<input type="checkbox" bind:checked={showHiddenDirectories} />
			<span>Show hidden folders</span>
		</label>
		{#if cwdBrowseLoading}
							<p class="cwd-browser-message">Loading folders…</p>
						{:else if cwdBrowseError}
						<p class="cwd-browser-message error">{cwdBrowseError}</p>
		{:else if visibleCwdBrowseEntries.length === 0}
			<p class="cwd-browser-message">No subfolders here.</p>
		{:else}
			<div class="cwd-directory-list" role="group" aria-label="Subfolders">
				{#each visibleCwdBrowseEntries as entry (entry.name)}
								<button class="cwd-directory" type="button" onclick={() => browseDirectories(`${cwdBrowsePath.replace(/[\\/]+$/, '')}/${entry.name}`)}>
									<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" /></svg>
									<span>{entry.name}</span><span aria-hidden="true">›</span>
								</button>
							{/each}
						</div>
						{/if}
					</div>
				{/if}
				{#if profileChoices.length > 0}
					<div class="create-row">
						<label for="new-profile">Profile</label>
						<select id="new-profile" class="profile-input" bind:value={newProfile}>
							<option value="">Base configuration</option>
							{#each profileChoices as p (p.name)}
								<option value={p.name}>{p.name}{p.model ? ` · ${p.model}` : ''}</option>
							{/each}
						</select>
					</div>
				{/if}
				<div class="create-actions">
					<button class="mini" disabled={cwdBrowseLoading} onclick={() => newSession(newCwd.trim() || undefined)}>Start session</button>
				</div>
				{#if createError}
					<div id="create-helper" class="create-err" role="alert">{createError}</div>
				{:else}
					<span id="create-helper" class="create-hint">Leave blank to use the default directory.</span>
				{/if}
			</div>
		{:else}
			<div class="rail-heading">
				<span>Sessions</span>
				<div class="rail-actions">
					<button class="settings-open" type="button" onclick={() => { settingsOpen = true; settingsDialog?.showModal(); }} aria-label="Settings" title="Settings">
						<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
						</svg>
					</button>
					<button class="new archive-browser-open" type="button" onclick={openArchiveBrowser} aria-label="Archived sessions" title="Archived sessions">
						<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
							<path d="M4 5.5h16l-1 4H5zM6 9.5v9h12v-9M10 13h4" />
						</svg>
					</button>
					<button class="new" type="button" onclick={startCreating} aria-label="New session" title="New session">
						<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
							<path d="M12 5v14" />
							<path d="M5 12h14" />
						</svg>
					</button>
				</div>
			</div>
		{/if}
			<nav class="sessions" data-loaded={sessionsLoaded}>
				{#each topSessions as s (s.id)}
					{@const sessionProgress = taskProgressForSession(s.id)}
					{@const sessionIsRunning = threads[s.id]?.status === 'running'}
					{@const showSessionProgress = sessionIsRunning && (sessionProgress?.percent ?? 0) < 100}
					{@const sessionTimeLeft = showSessionProgress && sessionProgress
						? estimatedSessionTimeLeft(s.id, sessionProgress)
						: null}
				<div
					class="session-row"
					data-session-row-id={s.id}
					role="group"
					aria-label={`Session ${shortLabel(s)}`}
					class:drop-target={dragOverSessionId === s.id && draggingSessionId !== s.id}
				>
					<button
						class="session-drag-handle"
						class:has-progress={showSessionProgress}
					type="button"
						aria-label={sessionTimeLeft ? `${sessionTimeLeft}; reorder ${shortLabel(s)}` : `Reorder ${shortLabel(s)}`}
						title={sessionTimeLeft ?? undefined}
						onpointerdown={(event) => startSessionDrag(event, s.id)}
						onpointermove={moveSessionDrag}
						onpointerup={finishSessionDrag}
						onpointercancel={finishSessionDrag}
						onkeydown={(event) => {
							if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
								event.preventDefault();
								moveSessionByKeyboard(s.id, event.key === 'ArrowUp' ? -1 : 1);
							}
						}}
					>
						{#if showSessionProgress}
							<span class="session-progress-percent" aria-hidden="true">{sessionProgress?.percent ?? 0}%</span>
						{:else}
							<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3h1M10 3h1M5 8h1m4 0h1m-6 5h1m4 0h1" /></svg>
						{/if}
					</button>
					<a
						class="session"
						class:active={s.id === activeId}
						class:dragging={draggingSessionId === s.id}
						data-id={s.id}
						href={`/s/${s.id}${hostQuery(s.host)}`}
						onpointerdown={(event) => startSessionDrag(event, s.id)}
						onpointermove={moveSessionDrag}
						onpointerup={finishSessionDrag}
						onpointercancel={finishSessionDrag}
						ondragstart={(event) => event.preventDefault()}
						onclick={(event) => activateSessionLink(event, s.id)}
					>
						<span
							class="run-dot"
							class:running={threads[s.id]?.status === 'running'}
							class:error={Boolean(threads[s.id]?.error)}
							class:interrupted={interruptedSessions[s.id]}
							role="img"
							aria-label={interruptedSessions[s.id] ? 'Interrupted by restart' : recoveringSessions[s.id] ? 'Checking task status' : threads[s.id]?.error ? 'Error' : threads[s.id]?.status === 'running' ? 'Running' : 'Idle'}
							title={interruptedSessions[s.id] ? 'Interrupted by restart' : recoveringSessions[s.id] ? 'Checking task status' : threads[s.id]?.error ? 'Error' : threads[s.id]?.status === 'running' ? 'Running' : 'Idle'}
						></span>
		<span class="label">
							{#if sessionAttentionById[s.id] && !(finishedSessions[s.id] && sessionAttentionById[s.id] === 'alert')}
								<span
									class="needs-input-indicator"
									class:choice={sessionAttentionById[s.id] === 'choice'}
									role="img"
									aria-label={sessionAttentionById[s.id] === 'choice' ? 'Codex is waiting for your choice' : 'Session needs your attention'}
									title={sessionAttentionById[s.id] === 'choice' ? 'Codex is waiting for your choice' : 'Session needs your attention'}
								>{sessionAttentionById[s.id] === 'choice' ? '?' : '!'}</span>
							{/if}
							{#if finishedSessions[s.id] && s.id !== activeId}<span class="session-finished-indicator" role="img" aria-label="Finished task" title="Task finished · open session to dismiss"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.2 2.8 2.8 6.2-6.2" /></svg></span>{/if}
					{#if isSideChat(s)}⎇ {/if}<span class="session-name">{shortLabel(s)}</span>
							{#if interruptedSessions[s.id]}<span class="session-interrupted">Interrupted</span>
							{:else if recoveringSessions[s.id]}<span class="session-interrupted checking">Checking…</span>{/if}
						</span>
						{#if isRemoteHost(s.host)}
							<span class="host-badge" title={`Runs on ${s.host}`}>{s.host}</span>
						{/if}
						{#if fastSessions[s.id]}{@render fastMark()}{/if}
					</a>
				</div>
				{#each sideChatsOf(s.id) as side (side.id)}
					<div class="session-row side-row">
						<a
							class="session side"
							class:active={side.id === activeId}
							data-id={side.id}
							href={`/s/${side.id}${hostQuery(side.host)}`}
							onclick={() => closeSidebar(false)}
						>
							<span
								class="run-dot"
								class:running={threads[side.id]?.status === 'running'}
								class:error={Boolean(threads[side.id]?.error)}
								role="img"
								aria-label={threads[side.id]?.error ? 'Error' : threads[side.id]?.status === 'running' ? 'Running' : 'Idle'}
								title={threads[side.id]?.error ? 'Error' : threads[side.id]?.status === 'running' ? 'Running' : 'Idle'}
							></span>
							<span class="label">
								{#if sessionAttentionById[side.id] && !(finishedSessions[side.id] && sessionAttentionById[side.id] === 'alert')}
									<span
										class="needs-input-indicator"
										class:choice={sessionAttentionById[side.id] === 'choice'}
										role="img"
										aria-label={sessionAttentionById[side.id] === 'choice' ? 'Codex is waiting for your choice' : 'Session needs your attention'}
										title={sessionAttentionById[side.id] === 'choice' ? 'Codex is waiting for your choice' : 'Session needs your attention'}
									>{sessionAttentionById[side.id] === 'choice' ? '?' : '!'}</span>
								{/if}
								{#if finishedSessions[side.id] && side.id !== activeId}<span class="session-finished-indicator" role="img" aria-label="Finished task" title="Task finished · open session to dismiss"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.2 2.8 2.8 6.2-6.2" /></svg></span>{/if}
								⎇ {shortLabel(side)}
							</span>
							{#if fastSessions[side.id]}{@render fastMark()}{/if}
						</a>
					</div>
				{/each}
			{:else}
				<div class="empty">
					<strong>No sessions yet</strong>
					<span>Start one to begin working with Codex.</span>
				</div>
			{/each}
		</nav>
		<div class="hint">
			<span>{topSessions.length} session{topSessions.length === 1 ? '' : 's'}</span>
		</div>
	</aside>

	<main class="chat">
		{#if !activeId}
			<div class="welcome">
				<div class="welcome-copy">
					<h1>Work through the hard parts.</h1>
					<p>
						Start a Codex session in any project, follow the work as it happens, and return to the
						conversation when you need it.
					</p>
					<button class="welcome-action" onclick={startCreating}>
						Start a session <span aria-hidden="true">→</span>
					</button>
				</div>
				<div class="welcome-details" aria-label="yacwu capabilities">
					<div>
						<strong>Keep context close</strong>
						<span>Move between persistent sessions without losing the thread.</span>
					</div>
					<div>
						<strong>See the work</strong>
						<span>Messages, commands, plans, and file changes arrive as they happen.</span>
					</div>
					<div>
						<strong>Stay in control</strong>
						<span>Set goals, switch models, fork conversations, or interrupt a running turn.</span>
					</div>
				</div>
			</div>
		{:else}
			<header class="topbar">
				<button
					class="sidebar-toggle header-menu"
					bind:this={sidebarToggleEl}
					aria-controls="session-sidebar"
					aria-label={sessionRailToggleLabel}
					aria-expanded={sessionRailOpen}
					onclick={toggleSidebar}
				>
					<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
						{#if mobileViewport && mobileSidebarOpen}
							<path d="M6 6l12 12M18 6 6 18" />
						{:else if !mobileViewport}
							<rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
							<path d="M9 5v14M12 9l3 3-3 3" />
						{:else}
							<path d="M4 7h16M4 12h16M4 17h16" />
						{/if}
					</svg>
				</button>
				<div class="session-heading">
					<div class="session-title-row">
						<h1>{headerLabel(activeSummary, activeId, cwds[activeId] ?? activeSummary?.cwd)}</h1>
						<button class="rename-session" type="button" aria-label="Rename session" title="Rename session" onclick={() => renameSession(activeId)}>
							<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m14 5 5 5M4 20l4.5-1 10.8-10.8a2.1 2.1 0 0 0-3-3L5.5 16 4 20Z" /></svg>
						</button>
					</div>
					<div class="session-meta">
						{#if activeParent}
							<span class="tid dim">From {activeParent.id.slice(0, 8)}</span>
							<span class="meta-sep" aria-hidden="true">·</span>
						{/if}
						<span class="tid">{activeId.slice(0, 8)}</span>
						{#if cwds[activeId] ?? activeSummary?.cwd}
							<span class="meta-sep" aria-hidden="true">·</span>
							<span class="meta cwd" title={cwds[activeId] ?? activeSummary?.cwd}>{cwds[activeId] ?? activeSummary?.cwd}</span>
						{/if}
		{#if activeAgents.length > 0}
			<nav class="agent-row" aria-label="Agent transcripts">
				<button
					type="button"
					class="agent-link"
					class:current={!viewedAgentId}
					aria-current={!viewedAgentId ? 'page' : undefined}
					title="Return to the session transcript"
					onclick={() => goto(agentHref(null))}
				>
					Session
				</button>
				{#each currentAgents as agent (agent.id)}
									<button
										type="button"
										class="agent-link"
										class:current={agent.id === viewedAgentId}
										class:closed={agent.closed}
										aria-current={agent.id === viewedAgentId ? 'true' : undefined}
										title={agentTitle(agent)}
										onclick={() => toggleAgent(agent.id)}
									>
										<span class="agent-dot" class:running={agentIsRunning(agent)} aria-hidden="true"></span>{agentLabel(agent)}
									</button>
								{/each}
								{#if previousAgents.length > 0}
									<details class="agent-history-group" open={previousAgents.some((agent) => agent.id === viewedAgentId)}>
										<summary>Previous · {previousAgents.length}</summary>
										<div class="agent-history-list">
											{#each previousAgents as agent (agent.id)}
												<button
													type="button"
													class="agent-link"
													class:current={agent.id === viewedAgentId}
													class:closed={agent.closed}
													aria-current={agent.id === viewedAgentId ? 'true' : undefined}
													title={agentTitle(agent)}
													onclick={() => toggleAgent(agent.id)}
												>
													<span class="agent-dot" aria-hidden="true"></span>{agentLabel(agent)}
												</button>
											{/each}
										</div>
									</details>
								{/if}
							</nav>
						{/if}
					</div>
				</div>
				<div class="session-facts" aria-label="session configuration">
					{#if fastSessions[activeId]}{@render fastMark()}{/if}
					{#if activeRemote}
						<span
							class="fact host"
							class:degraded={activeHostState !== 'connected'}
							title={activeHostState === 'connected'
								? `Session runs on ${activeHost}`
								: `Connection to ${activeHost} interrupted — the remote session keeps running; reconnecting`}
						>
							{activeHost}{activeHostState === 'connected' ? '' : ` · ${activeHostState}`}
						</span>
					{/if}
					{#if activeConfig?.model}
						<span
							class="fact model"
							title={`Model ${activeConfig.model}${activeConfig.effort ? `, ${activeConfig.effort} reasoning` : ''}`}
						>
							{activeConfig.model}{#if activeConfig.effort}<span class="fact-detail">/{activeConfig.effort}</span>{/if}
						</span>
					{/if}
					{#if activeConfig?.profile}
						<span class="fact profile" title={`Profile ${activeConfig.profile}`}>{activeConfig.profile}</span>
					{/if}
					{#if active?.tokens}
						<span class="fact tokens" title={`${active.tokens.toLocaleString()} tokens used`}>{fmtTokens(active.tokens)} tok</span>
					{/if}
				</div>
				<div class="session-state">
					{@render themeToggle()}
					<button
						class="files-trigger"
						type="button"
						bind:this={filesToggleEl}
						onclick={toggleFilesPanel}
						aria-pressed={filesOpen || changesOpen}
						aria-label={filesOpen || changesOpen ? 'Close workspace inspector' : 'Open workspace inspector'}
						title={filesOpen || changesOpen ? 'Close workspace inspector' : 'Files and changes'}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
							<path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
						</svg>
					</button>
					<button
						class="session-info-trigger"
						type="button"
						onclick={openSessionInfo}
						aria-label={`Session details, ${interruptedSessions[activeId] ? 'interrupted' : active?.error ? 'error' : active?.status === 'running' ? 'running' : 'idle'}`}
						title={`Session details · ${interruptedSessions[activeId] ? 'Interrupted by restart' : active?.error ? 'Error' : active?.status === 'running' ? 'Running' : 'Idle'}`}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
							<circle cx="12" cy="12" r="9" />
							<path d="M12 11v6" />
							<circle cx="12" cy="7.5" r=".75" class="info-dot" />
						</svg>
						<span
							class="session-state-dot"
							class:running={active?.status === 'running'}
							class:error={Boolean(active?.error)}
							class:interrupted={interruptedSessions[activeId]}
							aria-hidden="true"
						></span>
					</button>
					{#if active?.status === 'running'}
						<button class="stop" type="button" onclick={interrupt} disabled={stoppingSessions[activeId]} aria-label="Stop current turn" title="Stop current turn">
							<svg class="stop-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
								<rect x="7" y="7" width="10" height="10" rx="1" />
							</svg>
						</button>
					{:else if interruptedSessions[activeId]}
						<button class="stop play" type="button" onclick={playInterruptedSession} disabled={!startupRecoveryComplete || sendingMessage} aria-label="Continue interrupted task" title="Continue interrupted task">
							<svg class="play-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 4.8a1 1 0 0 1 1.5-.86l11 7.2a1 1 0 0 1 0 1.72l-11 7.2A1 1 0 0 1 7 19.2z" /></svg>
						</button>
					{/if}
				</div>
			</header>
			{#if sessionContextLine || activeClaude || activeAccountUsage?.fiveHour || activeAccountUsage?.sevenDay}
				<div class="original-prompt" aria-label={sessionContextLine ? `Session: ${sessionContextLine}` : 'Session and Codex usage'}>
					{#if active?.status === 'running' && !viewedAgentId}
						<div class="session-progress" role="status" aria-live="polite" aria-label={activeTaskProgress ? `Estimated ${activeTaskProgress.percent}% complete, ${formatEstimatedRemaining(activeTaskProgress.remainingMinutes)}` : 'Estimating task progress'}>
							{#if activeTaskProgress}
								<span class="session-progress-meter" aria-hidden="true"><span style={`width: ${activeTaskProgress.percent}%`}></span></span>
								<span>{activeTaskProgress.percent}% est.</span>
								<span>{formatEstimatedRemaining(activeTaskProgress.remainingMinutes)}</span>
							{:else}
								<span>Estimating…</span>
							{/if}
							<span class="task-cost" title={projectedTaskUsage
								? `Projected total weekly allowance from ${projectedTaskUsage.basis === 'progress' ? 'estimated completion' : 'elapsed time and time remaining'}. ${formatAllowancePercent(activeTaskUsage?.percent ?? null)} used so far; ${formatAllowancePercent(projectedTaskUsage.remaining)} estimated remaining. Includes recorded agent work.`
								: activeTaskUsage ? taskUsageTitle(activeTaskUsage) : 'Waiting for task usage recording and sufficient calibration.'}>
								{projectedTaskUsage ? `${formatAllowancePercent(projectedTaskUsage.total)} week total` : activeTaskUsage?.percent !== null && activeTaskUsage?.percent !== undefined ? `${formatAllowancePercent(activeTaskUsage.percent)} week so far` : activeTaskUsage?.knownPercent !== null && activeTaskUsage?.knownPercent !== undefined ? `${formatAllowancePercent(activeTaskUsage.knownPercent)} week · incomplete` : 'Cost learning…'}{#if activeTaskUsage?.knownPercent != null && activeTaskUsage.provisional} · early{/if}
							</span>
							{#if activeTaskUsage?.fiveHour?.knownPercent != null}
								<span class="task-cost" title={taskUsageTitle(activeTaskUsage)}>{projectedFiveHourTaskUsage ? `${formatAllowancePercent(projectedFiveHourTaskUsage.total)} 5h total${activeTaskUsage.fiveHour.provisional ? ' · early' : ''}` : fiveHourCostLabel(activeTaskUsage.fiveHour)}</span>
							{/if}
						</div>
					{/if}
					<span class="session-label" title={sessionContextTitle}>Session</span>
					{#if activeTodoQueue?.tasks.length}<span class="todo-position">[{activeTodoPosition}/{activeTodoTotal}]</span>{/if}
					<p>{sessionContextLine}</p>
						<div class="session-bar-right">
						{#if activeAccountUsage?.fiveHour || activeAccountUsage?.sevenDay}
							<div class="usage-limits" aria-label={`${activeClaude ? 'Claude' : 'Codex'} usage remaining`}>
								{#if activeAccountUsage.fiveHour}
									<span class="usage-window" title={`5-hour limit · resets in ${fmtReset(activeAccountUsage.fiveHour.resetsAt)}`}>
										<strong>5h</strong> {remainingPercent(activeAccountUsage.fiveHour)}% left
									</span>
								{/if}
								{#if activeAccountUsage.sevenDay}
									<button type="button" class="usage-window usage-details" onclick={() => usageHistoryOpen = true} title={`7-day limit · resets in ${fmtReset(activeAccountUsage.sevenDay.resetsAt)} · open task usage history`}>
										<strong>7d</strong> {remainingPercent(activeAccountUsage.sevenDay)}% left
									</button>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			{/if}

			<div
				class="workspace-split"
				class:inspector-open={filesOpen || changesOpen}
				bind:this={workspaceSplitEl}
				style={`--workspace-split: ${Math.round(workspaceSplitRatio * 100)}%`}
			>
				<div class="workspace-pane" hidden={!filesOpen && !changesOpen}>
					{#if filesOpen}
						{#key activeId}
							<FileBrowser
								threadId={activeId}
								cwd={cwds[activeId] ?? activeSummary?.cwd ?? ''}
								rootOverride={filesReveal?.root ?? null}
								host={activeHost}
								embedded
								{theme}
								reveal={filesReveal}
								refreshNonce={filesRefresh}
								onchanges={() => openChangesPanel()}
								onclose={closeFilesPanel}
							/>
						{/key}
					{/if}
					{#if changesOpen}
						{#key activeId}
							<GitDiffViewer
								threadId={activeId}
								cwd={cwds[activeId] ?? activeSummary?.cwd ?? ''}
								embedded
								{theme}
								reveal={changesReveal}
								refreshNonce={filesRefresh}
								onfiles={openFilesPanel}
								onviewfile={(path) => openFileInBrowser(path)}
								onclose={closeChangesPanel}
							/>
						{/key}
					{/if}
				</div>
				{#if filesOpen || changesOpen}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
					<div
						class="workspace-resizer"
						role="separator"
						tabindex="0"
						aria-label="Resize file viewer and transcript"
						aria-valuemin="20"
						aria-valuemax="70"
						aria-valuenow={Math.round(workspaceSplitRatio * 100)}
						aria-orientation={mobileViewport ? 'horizontal' : 'vertical'}
						onpointerdown={startWorkspaceResize}
						onpointermove={resizeWorkspace}
						onpointerup={finishWorkspaceResize}
						onpointercancel={finishWorkspaceResize}
						onkeydown={nudgeWorkspaceSplit}
					></div>
				{/if}
				<section class="conversation-pane">

			<dialog
				class="session-info-dialog"
				bind:this={sessionInfoDialog}
				aria-labelledby="session-info-title"
				tabindex="-1"
				onclick={closeSessionInfoOnBackdrop}
			>
				<div class="session-info-panel">
					<div class="session-info-heading">
						<h2 id="session-info-title">Session details</h2>
						<button class="session-info-close" type="button" onclick={() => sessionInfoDialog?.close()} aria-label="Close session details" title="Close">
							<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
								<path d="M6 6l12 12M18 6 6 18" />
							</svg>
						</button>
					</div>
					<dl class="session-info-list">
						<div>
							<dt>Session</dt>
							<dd>{activeId}</dd>
						</div>
						<div>
							<dt>Directory</dt>
							<dd>{cwds[activeId] ?? activeSummary?.cwd ?? '—'}</dd>
						</div>
						<div>
							<dt>Last modified</dt>
							<dd>
								<time datetime={sessionTimestampIso(activeSummary?.updatedAt)}>{fmtSessionTimestamp(activeSummary?.updatedAt)}</time>
							</dd>
						</div>
						<div>
							<dt>Model</dt>
							<dd>
								{activeModelChoice?.displayName ?? activeConfig?.model ?? '—'}
							</dd>
						</div>
						<div>
							<dt>Reasoning</dt>
							<dd>{activeConfig?.effort ?? '—'}</dd>
						</div>
						<div>
							<dt>Profile</dt>
							<dd>{activeConfig?.profile ?? 'Base configuration'}</dd>
						</div>
						<div>
							<dt>Fast mode</dt>
							<dd>{fastSessions[activeId] ? 'Enabled' : 'Disabled'}</dd>
						</div>
						<div>
							<dt>Tokens</dt>
							<dd>{active?.tokens?.toLocaleString() ?? '—'}</dd>
						</div>
						{#if active?.tokenStatistics}
							<div><dt>Reported total tokens</dt><dd>{active.tokenStatistics.totalTokens.toLocaleString()}</dd></div>
							<div><dt>Input tokens</dt><dd>{active.tokenStatistics.inputTokens.toLocaleString()}</dd></div>
							<div><dt>Cached input tokens</dt><dd>{active.tokenStatistics.cachedInputTokens.toLocaleString()}</dd></div>
							<div><dt>Output tokens</dt><dd>{active.tokenStatistics.outputTokens.toLocaleString()}</dd></div>
						{/if}
						<div>
							<dt>State</dt>
							<dd>{active?.status ?? 'idle'}</dd>
						</div>
						{#if activeParent}
							<div>
								<dt>Parent</dt>
								<dd>{activeParent.id}</dd>
							</div>
						{/if}
					</dl>
					{#key activeId}<SessionRulesEditor rules={rulesFor(activeId)} defaults={ruleDefaults()} onsave={(rules) => saveSessionRules(activeId, rules)} relayEnabled={relayEnabled[activeId] ?? null} onrelaychange={(enabled) => setRelayEnabled(activeId, enabled)} />{/key}
					<button class="mini" type="button" onclick={() => { sessionInfoDialog?.close(); usageHistoryOpen = true; }}>Task usage history</button>
					<div class="session-detail-actions">
						{#if !isSideChat(activeSummary)}
							<button class="session-clear-action" type="button" disabled={Boolean(clearingSessionId || sendingMessage || modelPending || effortPending || switchingPromptModel || !activeConfig || active?.status === 'running' || activeAgents.some(agentIsRunning))}
								title="Start an empty conversation with the same name, folder and settings; archive the previous history. Finish or stop active workers first. Used account allowance stays unchanged."
								onclick={() => void clearSession(activeId)}>{clearingSessionId === activeId ? 'Clearing…' : 'Clear session'}</button>
						{/if}
						<button class="session-remove-action" type="button" disabled={Boolean(clearingSessionId)} onclick={() => { sessionInfoDialog?.close(); void deleteSession(activeId); }}>
							{isSideChat(activeSummary) ? 'Remove side conversation' : 'Archive session'}
						</button>
					</div>
				</div>
			</dialog>



			<dialog
				class="interactive-choice-dialog"
				bind:this={interactiveChoiceDialog}
				aria-labelledby="interactive-choice-title"
				aria-describedby="interactive-choice-question"
				oncancel={dismissInteractiveChoice}
			>
				{#if pendingInteractiveChoice}
					<div class="interactive-choice-panel">
						<div class="session-info-heading">
							<h2 id="interactive-choice-title">Codex has a question</h2>
							{#if pendingInteractiveQuestions.length > 1}<span class="meta">1 of {pendingInteractiveQuestions.length}</span>{/if}
							<button class="session-info-close" type="button" onclick={dismissInteractiveChoice} aria-label="Dismiss question" title="Dismiss">
								<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" /></svg>
							</button>
						</div>
						<p id="interactive-choice-question">{pendingInteractiveChoice.question}</p>
						{#if pendingInteractiveChoice.options.length > 0}
						<div class="interactive-choice-options" aria-label="Choose a response">
							{#each pendingInteractiveChoice.options as option, index (option)}
								<button
									type="button"
									class="interactive-choice-option"
									disabled={sendingMessage}
									onclick={() => answerInteractiveChoice(option)}
								>
									<span>{index + 1}</span>{option}
								</button>
							{/each}
						</div>
						{/if}
						<form
							class="interactive-choice-other"
							onsubmit={(event) => {
								event.preventDefault();
								answerInteractiveChoice(choiceCustomAnswer);
							}}
						>
							<label for="interactive-choice-custom">{pendingInteractiveChoice.options.length > 0 ? 'Other' : 'Your answer'}</label>
							<textarea
								id="interactive-choice-custom"
								bind:value={choiceCustomAnswer}
								rows="2"
								placeholder="Type another answer…"
							></textarea>
							<button type="submit" class="mini" disabled={!choiceCustomAnswer.trim() || sendingMessage}>
								Send answer
							</button>
						</form>
					</div>
				{/if}
			</dialog>

			{#if activeIsSide}
				<div class="side-banner">
					<span class="side-banner-label">Side conversation · ephemeral — not saved</span>
					<span class="spacer"></span>
					{#if activeParent}
						<button class="mini ghost" onclick={() => goto(`/s/${activeParent.id}`)}>
							← {shortLabel(activeParent)}
						</button>
					{:else}
						<span class="meta">parent unavailable</span>
					{/if}
				</div>
			{/if}

			{#if active?.goal && dismissedGoalBySession[activeId] !== active.goal.objective}
				<div class="goal-tracker" aria-label="active goal">
					<div class="goal-main">
						<span class="goal-marker">◎</span>
						<span class="goal-objective" title={active.goal.objective}>{active.goal.objective}</span>
						<span class="goal-state">{active.goal.status}</span>
					</div>
					<div class="goal-metrics">
						{#if active.goal.tokenBudget}
							<div class="goal-progress" aria-label={`${goalBudgetPercent(active.goal)}% of token budget used`}>
								<span style={`width: ${goalBudgetPercent(active.goal)}%`}></span>
							</div>
							<span
								>{fmtTokens(active.goal.tokensUsed)} / {fmtTokens(active.goal.tokenBudget)}
								tok</span
							>
						{:else}
							<span>{fmtTokens(active.goal.tokensUsed)} tok</span>
						{/if}
						<span>{fmtDuration(active.goal.timeUsedSeconds ?? 0)}</span>
					</div>
					<button
						type="button"
						class="goal-dismiss"
						aria-label="Close goal bar"
						title="Close goal bar"
						onclick={() => dismissGoalBar(activeId, active.goal!.objective)}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" /></svg>
					</button>
				</div>
			{/if}

			{#if conflict && conflict.id === activeId}
				<div class="conflict">
					<div class="conflict-head">Session already open elsewhere</div>
					<div class="conflict-body">
						This conversation's rollout is open in
						{#each conflict.holders as h, i}{i > 0 ? ', ' : ' '}<code>{h.command} (pid {h.pid})</code>{/each}.
						Opening it here too can corrupt its history. Close the other instance first, or accept the risk.
					</div>
					<div class="conflict-actions">
						<button class="mini danger" onclick={forceOpen}>Open anyway</button>
						<button class="mini ghost" onclick={dismissConflict}>Cancel</button>
					</div>
				</div>
			{:else}
				<div class="transcript-frame" class:has-position-rail={transcriptJumpPoints.length > 1}>
					<div class="activity-toolbar"><label><input type="checkbox" bind:checked={showAllActivity} onchange={cancelBottomJump} /> Show all activity</label></div>
				<div class="transcript" bind:this={transcriptEl} use:cancelJumpOnInput onscroll={onTranscriptScroll}>
					{#if viewedAgentId ? agentHistoryLoading : sessionOpening[viewedId ?? '']}
						<div class="sys">loading history…</div>
					{:else if viewedItems.length === 0 && viewed?.status !== 'running' && !viewed?.error}
						{#if viewedAgentId}
							<div class="transcript-empty">
								<p class="transcript-empty-lede">Nothing from this agent yet.</p>
								<p class="transcript-empty-hint">
									Its activity will stream in here as the agent works.
								</p>
							</div>
						{:else}
							<div class="transcript-empty">
								<p class="transcript-empty-lede">This session is ready.</p>
								<p class="transcript-empty-hint">
									Describe what you want done in
									<strong>{workspaceLabel(cwds[activeId] ?? activeSummary?.cwd)}</strong>, or type
									<code>/</code> for a command.
								</p>
							</div>
						{/if}
					{/if}
					<div class="transcript-spacer" style={`height: ${virtualTranscript.before}px`}></div>
					{#each virtualTranscript.items as item (item.id)}
						<div class="virtual-row" use:measureTranscriptRow={transcriptRowKey(item)}>
							{#if item.type === 'userMessage'}
								<div class="item user">
									<div class="body media-body">
										{#each userParts(item) as part}
											{#if part.type === 'text'}
												<span>{part.text}</span>
											{:else if part.type === 'relay'}
												<div class="relay-block">
													{#each part.frames as frame}
														<div class="relay-frame">
															<div class="relay-meta" title={relayStatusLabel(frame.record)}>Relayed message from session {shortSession(frame.fromThread)} ({frame.fromHost}) · sender reported by the sending agent</div>
															<div class="relay-text">{frame.body}</div>
														</div>
													{/each}
												</div>
											{:else}
												<a class="message-image" href={imageSrc(part.path)} target="_blank" rel="noreferrer">
													<img src={imageSrc(part.path)} alt={imageLabel(part.path)} loading="lazy" />
													<span>{imageLabel(part.path)}</span>
												</a>
											{/if}
										{/each}
									</div>
								</div>
			{:else if item.type === 'agentMessage'}
				{@const rawShown = Boolean(agentRawShown[agentRawKey(item)])}
				{@const time = agentTime(item)}
				{@const turnDuration = (item as any)._turnDurationMs}
				{@const taskUsage = completedUsageByItem[item.id]}
								<!-- The tap handler is a touch-only hover surrogate; keyboard
								     users reach the toggle directly via focus. -->
								<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
								<div
									class="item agent"
									class:tapped={tappedAgentKey === agentRawKey(item)}
									onclick={() => onAgentMessageTap(item)}
								>
									<div class="body media-body">
										{#if rawShown}
										<pre class="agent-raw">{stripTaskProgressMarkers((item as any).text ?? '')}</pre>
									{:else}
										{#each agentParts((item as any).text ?? '') as part}
											{#if part.type === 'text'}
												<div class="markdown-body">{@render markdownBlocks(parseCodexMarkdown(part.text))}</div>
											{:else if part.type === 'image'}
												<a class="message-image" href={imageSrc(part.path)} target="_blank" rel="noreferrer">
													<img src={imageSrc(part.path)} alt={imageLabel(part.path)} loading="lazy" />
													<span>{imageLabel(part.path)}</span>
												</a>
											{/if}
										{/each}
									{/if}
					</div>
					<div class="agent-meta">
										{#if time}
											<time class="agent-time" datetime={time.iso} title={time.full}>{time.label}</time>
										{/if}
										{#if typeof turnDuration === 'number'}<span class="agent-duration" title="Time taken for this task">{formatDuration(turnDuration)}</span>{/if}
										{#if taskUsage}<span class="agent-usage" title={taskUsageTitle(taskUsage)}>{taskUsage.percent === null ? taskUsage.knownPercent !== null ? `${formatAllowancePercent(taskUsage.knownPercent)} week (incomplete${taskUsage.provisional ? ', early' : ''})` : 'Allowance learning' : `${formatAllowancePercent(taskUsage.percent)} week${taskUsage.provisional ? ' (early)' : ''}`} · {#if fiveHourCostLabel(taskUsage.fiveHour)}{fiveHourCostLabel(taskUsage.fiveHour)} · {/if}{taskUsage.partial ? '≥' : ''}{taskUsage.tokens.toLocaleString()} tokens{taskUsage.runningAgents ? ' · agents running' : ''}</span>{/if}
										<button
											type="button"
											class="copy-agent"
											aria-label={agentCopyStatus[agentRawKey(item)] === 'copied' ? 'Response copied' : agentCopyStatus[agentRawKey(item)] === 'failed' ? 'Could not copy response' : 'Copy response'}
											title={agentCopyStatus[agentRawKey(item)] === 'copied' ? 'Copied' : agentCopyStatus[agentRawKey(item)] === 'failed' ? 'Copy failed' : 'Copy response'}
											onclick={() => copyAgentResponse(item)}
										>
											<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2" /></svg>
											{agentCopyStatus[agentRawKey(item)] === 'copied' ? 'Copied' : agentCopyStatus[agentRawKey(item)] === 'failed' ? 'Copy failed' : 'Copy'}
										</button>
										{#if responseFileTargets(item).length}
											<button type="button" class="copy-agent" disabled={agentFileCopyStatus[agentRawKey(item)] === 'copying'} title="Copy all linked file contents with filename headings" onclick={() => copyResponseFiles(item)}>
												{agentFileCopyStatus[agentRawKey(item)] === 'copying' ? 'Copying files…' : agentFileCopyStatus[agentRawKey(item)] === 'copied' ? 'Files copied' : agentFileCopyStatus[agentRawKey(item)] === 'failed' ? 'Copy files failed' : 'Copy files'}
											</button>
										{/if}
										<button
											type="button"
											class="raw-toggle"
											aria-pressed={rawShown}
											aria-label={rawShown ? 'Show rendered Markdown' : 'Show raw Markdown'}
											title={rawShown ? 'Show rendered Markdown' : 'Show raw Markdown'}
											onclick={() => toggleAgentRaw(item)}
										>
											<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
												{#if rawShown}
													<path d="M4 7h16M4 12h10M4 17h13" />
												{:else}
													<path d="m9 8-4 4 4 4M15 8l4 4-4 4" />
												{/if}
											</svg>
										</button>
									</div>
								</div>
							{:else if item.type === 'taskProgress'}
								<div class="item task-progress-entry" role="status" aria-label={`Task progress ${(item as any).percent} percent, ${(item as any).percent >= 100 ? 'complete' : formatEstimatedRemaining(progressEntryRemaining(item, viewedItems.findIndex((entry) => entry.id === item.id)))}`}>
									<span class="gutter">↗</span>
									<div class="message-progress">
										<span class="message-progress-label">Progress</span>
										<span aria-hidden="true">·</span>
										<strong>{(item as any).percent}%</strong>
										<span class="message-progress-meter" aria-hidden="true"><span style={`width: ${(item as any).percent}%`}></span></span>
										<span aria-hidden="true">·</span>
										<span>{(item as any).percent >= 100 ? 'Complete' : formatEstimatedRemaining(progressEntryRemaining(item, viewedItems.findIndex((entry) => entry.id === item.id)))}</span>
									</div>
								</div>
							{:else if item.type === 'reasoning'}
								{#if reasoningText(item)}
									<div class="item reason">
										<span class="gutter">∴</span>
										<div class="body">{reasoningText(item)}</div>
									</div>
								{/if}
							{:else if item.type === 'compactActivity'}
								<div class="item compact-activity">
									<button type="button" class="activity-group-toggle" title={compactActivityLabel(item)} aria-expanded={Boolean(expandedActivity[`${viewedId}:${item.id}`])} onclick={() => toggleActivityGroup(item.id)}>
										<span aria-hidden="true">{expandedActivity[`${viewedId}:${item.id}`] ? '▾' : '▸'}</span><span class="activity-group-label">{compactActivityLabel(item)}</span>
									</button>
								</div>
							{:else if item.type === 'commandExecution'}
								{@const output = commandOutput(item)}
								{@const outputExpanded = commandOutputIsExpanded(item, output)}
								<div class="item cmd">
									{#if output}
										<button
											type="button"
											class="cmd-line cmd-toggle"
											aria-expanded={outputExpanded}
											aria-controls={commandOutputId(item)}
											title={outputExpanded ? 'Collapse command output' : 'Expand command output'}
											onclick={() => toggleCommandOutput(item, output)}
										>
											<span class="gutter">$</span>
											<span class="cmd-text">{displayCommand((item as any).command)}</span>
											<span class="cmd-meta">
												{#if commandOutputIsLong(output)}
													<span class="cmd-output-count">{commandOutputCountLabel(output)}</span>
												{/if}
												{@render commandResult(item)}
												<svg class="cmd-disclosure" class:expanded={outputExpanded} viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
											</span>
										</button>
										<div id={commandOutputId(item)} class="cmd-output-region" hidden={!outputExpanded}>
											{#if outputExpanded}<pre class="cmd-out">{output}</pre>{/if}
										</div>
									{:else}
										<div class="cmd-line">
											<span class="gutter">$</span>
											<span class="cmd-text">{displayCommand((item as any).command)}</span>
											<span class="cmd-meta">{@render commandResult(item)}</span>
										</div>
									{/if}
								</div>
							{:else if item.type === 'mcpToolCall'}
								<McpToolActivity {item} />
							{:else if item.type === 'fileChange'}
								<div class="item file">
									<div class="body">
						{#each (item as any).changes ?? [] as ch}
							{@const rel = displayFileChangePath(ch)}
							{@const lineStats = fileChangeStats(ch)}
							<div class="fc">
								<span class="kind {fileChangeClass(ch)}" aria-label={fileChangeKind(ch)} title={fileChangeKind(ch)}>{fileChangeSymbol(ch)}</span>
								{#if !rel.startsWith('/')}
									<button type="button" class="path path-link" title="Review current diff" onclick={() => openChangesPanel(rel)}>{rel}</button>
								{:else}
									<span class="path">{rel}</span>
								{/if}
								{#if lineStats && lineStats.additions !== null && lineStats.deletions !== null}
									<span class="fc-line-stats" aria-label={`${lineStats.additions} lines added, ${lineStats.deletions} lines removed`}><span>+{lineStats.additions}</span><span>−{lineStats.deletions}</span></span>
								{/if}
							</div>
										{/each}
									</div>
								</div>
							{:else if item.type === 'webSearch'}
								{@const search = webSearchPresentation(item)}
								<div class="item web-search">
									<span class="gutter web-search-icon" aria-hidden="true">
										<svg viewBox="0 0 16 16" focusable="false">
											<circle cx="7" cy="7" r="4.25" />
											<path d="m10.25 10.25 3 3" />
										</svg>
									</span>
									<div class="body">
										<span>{search.label}</span>{#if search.detail}
											{' '}{#if search.href}<a href={search.href} target="_blank" rel="noreferrer noopener">{search.detail}</a>{:else}<span class="web-search-detail">{search.detail}</span>{/if}
										{/if}{#if search.resultCount > 0}<span class="web-search-count"> · {search.resultCount} {search.resultCount === 1 ? 'result' : 'results'}</span>{/if}
									</div>
								</div>
							{:else if item.type === 'plan'}
								<div class="item plan">
									<span class="gutter">◇</span>
									<div class="body">
										{#if (item as any).plan}
											{#each (item as any).plan as step}
												<div class="step {step.status}">[{step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '~' : ' '}] {step.step}</div>
											{/each}
										{:else}{(item as any).text}{/if}
									</div>
								</div>
							{:else if item.type === 'localNote'}
								<div class="item note {(item as any).tone}">
									<span class="gutter">/</span>
									<div class="body">{(item as any).text}{#if (item as any).resumeAvailable && viewed?.status !== 'running'}
										<button class="mini ghost stopped-resume" type="button" disabled={sendingMessage} onclick={() => resumeStoppedTask(activeId, (item as any).id)}>Resume</button>
									{/if}</div>
								</div>
							{:else if item.type === 'relayNotice'}
								{@const record = (item as any).record as RelayRecord}
								<div class="item note relay-notice relay-{record.state}">
									<span class="gutter">⇄</span>
									<details class="body">
										<summary>{(item as any).direction === 'in' ? `Message from session ${shortSession(record.from.thread)}` : `Message to session ${shortSession(record.to.thread)}`}: {relayStatusLabel(record)}</summary>
										<div class="relay-text">{record.text}</div>
									</details>
								</div>
							{:else if item.type === 'stalledWorkerPrompt'}
								<div class="item note stalled-worker-prompt">
									<span class="gutter">…</span>
									<div class="body">
										<div>{(item as any).text}</div>
										<div class="stall-actions">
											<button class="mini ghost" type="button" onclick={() => dismissStalledWorkerPrompt(activeId, (item as any).id)}>Keep waiting</button>
											<button class="mini ghost" type="button" onclick={() => askStalledWorkerStatus(activeId, item)}>Ask Codex for a status update</button>
											<button class="mini danger" type="button" disabled={Boolean(stoppingSessions[(item as any).workerId])} onclick={() => stopStalledWorker(activeId, item)}>Stop worker</button>
										</div>
									</div>
								</div>
							{:else if item.type === 'enteredReviewMode'}
								<div class="item note">
									<span class="gutter">⚑</span>
									<div class="body">review started: {(item as any).review}</div>
								</div>
							{:else if item.type === 'exitedReviewMode'}
								<div class="item review">
									<span class="gutter">⚑</span>
									<div class="body">{(item as any).review}</div>
								</div>
							{:else if item.type === 'contextCompaction'}
								<div class="item note">
									<span class="gutter">⤳</span>
									<div class="body">history compacted</div>
								</div>
							{:else if item.type === 'subAgentActivity'}
								{@const activity = subAgentActivityParts(item)}
								<div class="item subagent" title={`agent thread ${(item as any).agentThreadId ?? ''}`}>
									<span class="gutter">⎇</span>
									<div class="body">{activity.prefix} {#if (item as any).agentThreadId && (item as any).agentThreadId !== activeId}<button type="button" class="agent-path agent-activity-link" onclick={() => openAgentActivity(item)} title="Open this agent's transcript">{activity.path}</button>{:else}<span class="agent-path">{activity.path}</span>{/if}</div>
								</div>
							{:else if item.type === 'collabAgentToolCall'}
								<div class="item collab">
									<div class="collab-line">
										<span class="gutter">⇄</span>
										<span class="collab-text">{collabSummary(item)}</span>
										<span class="cmd-status {(item as any).status}">{(item as any).status}</span>
									</div>
									{#if (item as any).prompt}
										<div class="collab-detail">{truncateText((item as any).prompt, 160)}</div>
									{/if}
									{#if (item as any).tool === 'spawnAgent' && ((item as any).model || (item as any).reasoningEffort)}
										<div class="collab-detail">
											{(item as any).model ?? ''}{#if (item as any).reasoningEffort} · {(item as any).reasoningEffort}{/if}
										</div>
									{/if}
									{#if (item as any).tool === 'wait' && (item as any).status !== 'inProgress'}
										{#each collabAgentStates(item) as agent}
											<div class="collab-detail">
												{agent.id}: {agent.status}{#if agent.message} — {truncateText(agent.message, 160)}{/if}
											</div>
										{/each}
									{/if}
								</div>
								{@const started = unannouncedSpawn(item, announcedAgents, agents)}
								{#if started}
									<div class="item subagent" title={`agent thread ${started.agentThreadId}`}>
										<span class="gutter">⎇</span>
										<div class="body">Started {#if started.agentThreadId !== activeId}<button type="button" class="agent-path agent-activity-link" onclick={() => openAgentActivity({ agentThreadId: started.agentThreadId })} title="Open this agent's transcript">{started.path}</button>{:else}<span class="agent-path">{started.path}</span>{/if}</div>
									</div>
								{/if}
							{:else}
								<div class="item generic">
									<span class="gutter">·</span>
									<div class="body">{item.type}</div>
								</div>
							{/if}
						</div>
					{/each}
					<div class="transcript-spacer" style={`height: ${virtualTranscript.after}px`}></div>
					{#if viewed?.status === 'running'}
						<div class="item agent pending">
							<div class="body">
								<span class="working-label">Current activity</span>
								<span class="activity-spinner" role="img" aria-label="Working" title="Working"></span>
								{#if viewedTurnElapsed}<span class="working-duration" title="Time this task has been running">{viewedTurnElapsed}</span>{/if}
								<span class="working-description">{currentWorkDescription(viewedItems)}</span>
							</div>
						</div>
					{/if}
					{#if viewed?.error}
						<div class="item err">
							<span class="gutter">✗</span>
							<div class="body">{viewed.error}</div>
							{#if viewed.error === MODEL_CAPACITY_ERROR && !viewedAgentId}
								<button class="retry-capacity" type="button" onclick={retryLastPrompt} disabled={sendingMessage}>
									{sendingMessage ? 'Retrying…' : 'Retry'}
								</button>
							{/if}
						</div>
					{/if}
				</div>
				{#if transcriptJumpPoints.length > 1}
					<nav class="transcript-position" aria-label="Jump to a message in this conversation">
						{#each transcriptJumpPoints as point, index (point.id)}
							<button
								type="button"
								class:active={point.id === activeTranscriptPointId}
								style={`top: ${point.top}%`}
								aria-label={`Jump to message ${index + 1}: ${point.label}`}
								title={point.label}
								onclick={() => jumpToTranscriptPoint(point.index)}
							><span></span></button>
						{/each}
					</nav>
				{/if}
				</div>
				{#if unseenActivity || showBottomJump}
					<div class="activity-jump">
						<button class="new-activity" type="button" onclick={scrollToBottom}>
							{unseenActivity ? 'New activity' : 'Scroll to bottom'}
							<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v11M4 9l4 4 4-4" /></svg>
						</button>
					</div>
				{/if}

				{#if viewedAgentId}
					<!-- Collab agent threads are owned by their parent turn; their
					     transcripts are read-only here, so the composer yields to a
					     quiet return strip. -->
					<div class="agent-banner">
						<span class="agent-banner-label">
							Agent transcript
							{#if viewedAgent}
								· {agentLabel(viewedAgent)}{#if viewedAgent.role}&nbsp;<span class="agent-menu-role">[{viewedAgent.role}]</span>{/if}
								· {agentStateLabel(viewedAgent)}
							{/if}
							· read-only
						</span>
						<span class="spacer"></span>
					</div>
				{:else}
				<div class="composer-shell">
					<span class="composer-state" aria-live="polite">
						{selectedAttachments.length > 0 ? `${selectedAttachments.length} attachment${selectedAttachments.length === 1 ? '' : 's'} ready` : ''}
					</span>
					{#if selectedAttachments.length > 0}
						<div class="attachments" aria-label="Attached files">
							{#each selectedAttachments as attachment (attachment.id)}
								<button
									class="attachment"
									type="button"
									onclick={() => removeSelectedAttachment(attachment.id)}
									aria-label={`Remove ${attachment.name}`}
									title={`Remove ${attachment.name}`}
								>
									{#if attachment.previewUrl}
										<img class="attachment-preview" src={attachment.previewUrl} alt="" />
									{:else}
										<span class="attachment-file-icon" aria-hidden="true">{attachment.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'FILE'}</span>
									{/if}
									<span>{attachment.name}</span>
									<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
										<path d="M4 4l8 8M12 4l-8 8" />
									</svg>
								</button>
							{/each}
						</div>
					{/if}
					<div class="composer-anchor">
						{#if slashPopupVisible}
							<div class="slash-popup" id="slash-popup" role="listbox" aria-label="Slash commands">
								{#each slashMatches as cmd, i (cmd.name)}
									<button
										type="button"
										class="slash-option"
										class:selected={i === slashIndex}
										id={slashOptionId(cmd)}
										role="option"
										aria-selected={i === slashIndex}
										onmousedown={(e) => e.preventDefault()}
										onclick={() => acceptSlashCompletion(cmd, false)}
										onpointerenter={() => (slashIndex = i)}
									>
										<span class="slash-name">{cmd.name}</span>
										{#if cmd.args}<span class="slash-args">{cmd.args}</span>{/if}
										<span class="slash-desc">{cmd.description}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
					<div class="composer">
						<input
							bind:this={imageInputEl}
							class="image-input"
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,.pdf,.txt,.text,.md,.markdown,.rst,.log,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.htm,.css,.scss,.sass,.less,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.pyw,.go,.rs,.java,.kt,.c,.h,.cc,.hh,.cpp,.hpp,.cs,.fs,.rb,.php,.pl,.pm,.sh,.bash,.zsh,.fish,.sql,.diff,.patch,.ini,.conf,.cfg,.properties,.proto,.graphql,.gql,.ex,.exs,.gleam,.erl,.hrl,.swift,.m,.mm,.r,.lua,.ps1,.bat,.dockerfile,.makefile,.gitignore,.env"
							multiple
							onchange={onAttachmentsSelected}
						/>
						<textarea
							bind:this={composerTextareaEl}
							aria-label="Message Codex"
							placeholder={composerPlaceholder}
							bind:value={input}
							oninput={resizeComposer}
							onpaste={onComposerPaste}
							onkeydown={onKeydown}
							enterkeyhint={mobileViewport ? 'enter' : 'send'}
							autocapitalize="sentences"
							autocomplete="off"
							spellcheck="true"
							rows="1"
							role="combobox"
							aria-autocomplete="list"
							aria-haspopup="listbox"
							aria-expanded={slashPopupVisible}
							aria-controls={slashPopupVisible ? 'slash-popup' : undefined}
							aria-activedescendant={slashPopupVisible && slashMatches[slashIndex]
								? slashOptionId(slashMatches[slashIndex])
								: undefined}
						></textarea>
						<div class="composer-actions">
							<button class="attach" type="button" onclick={chooseAttachments} title="Attach an image, PDF, text, or code file, or paste a file into the prompt" aria-label="Attach a supported file or paste from clipboard">
								<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
									<path d="M12 5v14M5 12h14" />
								</svg>
							</button>
							<div class="composer-actions-end">
								{#key activeId}
									<ModelSuggestion prompt={input} models={activeModels} attachments={selectedAttachments.length} disabled={modelPending || effortPending || switchingPromptModel} running={active?.status === 'running'} onapply={applySuggestedSettings} />
								{/key}
				{#if activeConfig && activeModels.length > 0}
					<div class="model-picker">
						<span class="model-picker-copy">
							<span class="model-picker-label" aria-hidden="true">{activeModelChoice?.displayName ?? activeConfig.model}</span>
						</span>
						<svg class="composer-select-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
											<path d="m6 9 6 6 6-6" />
										</svg>
										<select
											class="composer-select"
											aria-label="Model"
											value={activePickerModel}
											disabled={modelPending || effortPending || switchingPromptModel}
											onchange={(event) => setComposerModel(event.currentTarget)}
						>
											{#if activeConfig.model !== 'default' && !activeModels.some((choice) => choice.id === activePickerModel)}
												<option value={activeConfig.model} disabled>{activeModelChoice?.displayName ?? activeConfig.model} · current</option>
											{/if}
							{#each activeModels as choice (choice.id)}
								{@const profile = modelDisplayProfile(choice)}
								<option value={choice.id} title={profile?.estimateBasis}>
									{choice.displayName || choice.id}{profile ? ` · Cap ~${profile.capability} · ${profile.efficiency} · ${profile.valueRating.toFixed(1)}` : ''}
								</option>
							{/each}
									</select>
									</div>
								{/if}
								{#if activeSettingsChangedDuringTurn && !activeTodoQueue}
									<button
										class="switch-prompt-model"
										type="button"
										onclick={restartPromptWithSelectedSettings}
										disabled={switchingPromptModel || modelPending || sendingMessage || Boolean(activeId && stoppingSessions[activeId])}
										aria-label={`Stop the current turn and restart its prompt with ${activeModelChoice?.displayName ?? activeConfig?.model} at ${effortLabel(activeConfig?.effort ?? '')} thinking strength`}
										title="Model and thinking-strength changes do not affect a running turn. This stops it and starts the prompt again with the selected settings."
									>
										{switchingPromptModel ? 'Restarting…' : 'Restart on selected settings'}
									</button>
								{/if}
								{#if activeConfig && activeEfforts.length > 0}
									<div class="effort">
										<span class="effort-label" aria-hidden="true">{effortLabel(activeConfig.effort)} <span class="thinking-cost">{thinkingCostLabel(activeConfig.effort)}</span></span>
										<svg class="composer-select-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
											<path d="m6 9 6 6 6-6" />
										</svg>
										<select
											class="composer-select"
											aria-label="Thinking strength"
											value={activeConfig.effort}
											disabled={modelPending || effortPending || switchingPromptModel}
											onchange={(event) => setComposerEffort(event.currentTarget)}
										>
											{#each activeEfforts as choice (choice)}
												<option value={choice}>{effortLabel(choice)} · {thinkingCostLabel(choice)}</option>
											{/each}
										</select>
									</div>
								{/if}
								<button
									class="send"
									type="button"
									onclick={() => send()}
										disabled={sendingMessage || (!input.trim() && selectedAttachments.length === 0)}
					aria-label={sendingMessage ? 'Sending message' : activeId && threads[activeId]?.status === 'running' && threads[activeId]?.turnId ? 'Steer active task' : 'Send message'}
					title={activeId && threads[activeId]?.status === 'running' && threads[activeId]?.turnId ? 'Send guidance to the active task' : 'Send message'}
									aria-busy={sendingMessage}
								>
									<svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
										<path d="m18 15-6-6-6 6" />
										<path d="M12 9v12" />
									</svg>
								</button>
							</div>
						</div>
					</div>
				</div>
				{/if}
			{/if}
				</section>
			</div>
		{/if}
				<dialog
				class="archive-browser-dialog"
				bind:this={archiveBrowserDialog}
				aria-labelledby="archive-browser-title"
				onclick={(event) => { if (event.target === archiveBrowserDialog) archiveBrowserDialog?.close(); }}
			>
				<div class="archive-browser-panel">
					<div class="session-info-heading">
						<h2 id="archive-browser-title">Archived sessions</h2>
						<button class="mini ghost" type="button" onclick={loadArchivedSessions} disabled={archivedSessionsLoading || Boolean(restoringArchivedSessionId || deletingArchivedSessionId)}>Refresh</button>
						<button class="session-info-close" type="button" onclick={() => archiveBrowserDialog?.close()} aria-label="Close archived sessions" title="Close">
							<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18" /></svg>
						</button>
					</div>
					<div class="archive-filter-controls">
						<label>Provider <select aria-label="Archived session provider" bind:value={archiveFilter} disabled={deletingAllArchives}><option value="all">All</option><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
						<button class="mini archive-delete" type="button" disabled={archivedSessionsLoading || Boolean(restoringArchivedSessionId || deletingArchivedSessionId) || !deletableArchives.length} onclick={deleteAllArchivedSessions}>{deletingAllArchives ? 'Deleting…' : 'Delete all'}</button>
					</div>
					{#if archiveNotice}<p class="archive-browser-empty" role={archiveNotice.tone === 'error' ? 'alert' : 'status'}>{archiveNotice.message}</p>{/if}
					{#if visibleArchivedSessions.some((session) => !archiveDeletionSupported(session, hostChoices))}<p class="archive-browser-empty">Claude's current adapter supports archive and restore, but not permanent deletion. Delete all leaves those sessions untouched.</p>{/if}
					{#if archivedSessionsLoading && archivedSessions.length === 0}
						<p class="archive-browser-empty">Loading archived sessions…</p>
					{:else if archivedSessionsError && archivedSessions.length === 0}
						<p class="archive-browser-empty error" role="alert">{archivedSessionsError}</p>
					{:else if visibleArchivedSessions.length === 0}
						<p class="archive-browser-empty">No archived sessions in this filter.</p>
					{:else}
						{#if archivedSessionsError}<p class="archive-browser-empty error" role="alert">{archivedSessionsError}</p>{/if}
						<div class="archive-browser-list">
							{#each visibleArchivedSessions as session (`${session.host}:${session.id}`)}
								<div class="archive-browser-row">
									<div class="archive-browser-copy">
										<strong>{shortLabel(session)}</strong>
										{#if session.preview}<span>{session.preview}</span>{/if}
										<small>{archiveProviderLabel(session, hostChoices)} · {session.cwd ?? 'Unknown folder'} · {fmtSessionTimestamp(session.updatedAt)}</small>
									</div>
									<div class="archive-browser-actions">
										<button class="mini" type="button" disabled={Boolean(restoringArchivedSessionId || deletingArchivedSessionId)} onclick={() => restoreArchivedSession(session)}>
											{restoringArchivedSessionId === session.id ? 'Restoring…' : 'Restore'}
										</button>
										<button class="mini archive-delete" type="button" title={archiveDeletionSupported(session, hostChoices) ? 'Permanently delete this archived session' : 'Claude backend does not support permanent deletion'} disabled={!archiveDeletionSupported(session, hostChoices) || Boolean(restoringArchivedSessionId || deletingArchivedSessionId)} onclick={() => deleteArchivedSession(session)}>
											{deletingArchivedSessionId === session.id ? 'Deleting…' : 'Delete'}
										</button>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</dialog>
	</main>
</div>

{#if usageHistoryOpen && activeId}
	{#key `${activeHost}:${activeId}`}
		<UsageHistory host={activeHost} sessionId={activeId} models={activeModels} selectedModel={activeConfig?.model} selectedEffort={activeConfig?.effort} onclose={() => usageHistoryOpen = false} />
	{/key}
{/if}

{#if archiveNotice}
	<div class="archive-toast {archiveNotice.tone}" role={archiveNotice.tone === 'error' ? 'alert' : 'status'}>
		<span>{archiveNotice.message}</span>
		{#if archiveNotice.snapshot}
			<button type="button" onclick={undoArchivedSession}>Undo</button>
		{/if}
	</div>
{/if}

{#if instantTooltip}
	<div
		id="yacwu-instant-tooltip"
		class="instant-tooltip"
		class:wide={instantTooltip.wide}
		popover="manual"
		use:tooltipInTopLayer={instantTooltip}
		role="tooltip"
		style={`left: ${instantTooltip.left}px; top: ${instantTooltip.top}px`}
	>{instantTooltip.text}</div>
{/if}

{@render children()}

<style>
	/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5
	 * genre: modern-minimal · macrostructure: Workbench · nav: N3 session rail · tone: warm editorial utility
	 * anchor hue: coral · density: compact-workbench · design-system: design.md · designed-as-app · contrast: pass (40–41)
	 * slop: pass (42–45) · honest: pass (46) · chrome: pass (47) · tokens: pass (48)
	 * responsive: pass (34, 49) · icons: pass (30) · mobile: pass (34, 49, 50–57)
	 */
	@import '../../tokens.css';

	.instant-tooltip {
		margin: 0;
		inset: auto;
		position: fixed;
		z-index: 10000;
		width: max-content;
		max-width: min(18rem, calc(100vw - 1rem));
		padding: var(--space-2xs) var(--space-xs);
		border: 1px solid var(--color-rule-2);
		border-radius: var(--radius-card);
		background: var(--color-paper-3);
		box-shadow: var(--shadow-popover);
		color: var(--color-ink);
		font-size: var(--text-xs);
		line-height: 1.4;
		white-space: pre-line;
		overflow-wrap: anywhere;
		pointer-events: none;
	}

	.instant-tooltip.wide {
		max-width: min(35rem, calc(100vw - 1rem));
		max-height: min(60vh, 28rem);
		overflow: auto;
	}
	.archive-filter-controls { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); margin-block: var(--space-sm); }
	.archive-filter-controls label { display: flex; align-items: center; gap: var(--space-xs); }
	.archive-filter-controls select { color: var(--color-ink); background: var(--color-paper); border: 1px solid var(--color-rule); border-radius: var(--radius-input); padding: var(--space-2xs); }

	:global(*) {
		box-sizing: border-box;
	}

	:global(html),
	:global(body) {
		margin: 0;
		min-width: 20rem;
		height: 100%;
		overflow-x: clip;
		background: var(--color-paper);
		color: var(--color-ink);
		font-family: var(--font-body);
		font-size: var(--text-base);
		line-height: 1.55;
		text-rendering: optimizeLegibility;
	}

	:global(body) {
		overflow-y: hidden;
	}

	:global(button),
	:global(input),
	:global(select),
	:global(textarea) {
		font: inherit;
	}

	:global(button),
	:global(a) {
		-webkit-tap-highlight-color: transparent;
	}

	:global(::selection) {
		background: var(--color-accent-soft);
		color: var(--color-ink);
	}

	:global(*) {
		scrollbar-color: var(--color-rule-2) transparent;
		scrollbar-width: thin;
	}

	:global(::-webkit-scrollbar) {
		width: var(--space-xs);
		height: var(--space-xs);
	}

	:global(::-webkit-scrollbar-thumb) {
		background: var(--color-rule-2);
		border: var(--space-3xs) solid transparent;
		border-radius: var(--radius-pill);
		background-clip: padding-box;
	}

	:global(::-webkit-scrollbar-track) {
		background: transparent;
	}

	:global(:focus) {
		outline: none;
	}

	:global(:focus-visible) {
		outline: var(--rule-fine) solid var(--color-focus);
		outline-offset: var(--focus-offset);
	}

	.app {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		width: 100%;
		height: 100dvh;
		min-height: 0;
		overflow: clip;
		background: var(--color-paper);
	}

	.sidebar-toggle {
		position: fixed;
		inset-block-start: calc(var(--space-3xs) + env(safe-area-inset-top));
		inset-inline-start: var(--space-xs);
		z-index: var(--z-toast);
		display: grid;
		place-items: center;
		width: var(--control-height);
		height: var(--control-height);
		padding: 0;
		border: var(--rule-hair) solid var(--color-rule);
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--color-ink);
		cursor: pointer;
		white-space: nowrap;
		box-shadow: var(--shadow-card);
		transition:
			color var(--dur-micro) var(--ease-out),
			transform var(--dur-micro) var(--ease-out);
	}

	.header-menu {
		position: static;
		inset: auto;
		z-index: auto;
		border-color: transparent;
		background: transparent;
		box-shadow: none;
	}

	.sidebar-scrim {
		position: fixed;
		inset: 0;
		z-index: var(--z-sticky);
		display: block;
		padding: 0;
		border: 0;
		background: var(--color-overlay);
		visibility: hidden;
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--dur-short) var(--ease-in);
	}

	.sidebar-scrim:disabled {
		opacity: 0;
		cursor: default;
	}

	.app.sidebar-open .sidebar-scrim {
		visibility: visible;
		opacity: 1;
		pointer-events: auto;
		transition-timing-function: var(--ease-out);
	}

	.sidebar {
		position: fixed;
		inset-block: 0;
		inset-inline-start: 0;
		z-index: var(--z-modal);
		display: flex;
		flex-direction: column;
		width: min(88%, var(--rail-width));
		min-width: 0;
		min-height: 0;
		padding-block-start: env(safe-area-inset-top);
		border-inline-end: var(--rule-hair) solid var(--color-rule);
		background: var(--color-paper-2);
		box-shadow: none;
		transform: translateX(-100%);
		transition: transform var(--dur-short) var(--ease-in);
	}

	.sidebar.open {
		box-shadow: var(--shadow-drawer);
		transform: translateX(0);
		transition-timing-function: var(--ease-out);
	}

	.brand {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		min-height: var(--rail-header-height);
		padding: var(--space-xs) var(--space-sm);
		border-block-end: var(--rule-hair) solid var(--color-rule);
	}

	.brand-identity {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		min-width: 0;
		color: var(--color-ink);
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: 650;
		letter-spacing: -0.035em;
		text-decoration: none;
	}

	.brand-identity img {
		flex: 0 0 auto;
		border-radius: var(--radius-input);
	}

	.drawer-close {
		display: grid;
		place-items: center;
		width: var(--control-height);
		height: var(--control-height);
		padding: 0;
		border: var(--rule-hair) solid transparent;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--color-ink);
		cursor: pointer;
	}

	.connection {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2xs);
		color: var(--color-muted);
		font-size: var(--text-xs);
		font-weight: 500;
		white-space: nowrap;
	}

	.dot,
	.run-dot {
		flex: none;
		width: var(--space-2xs);
		height: var(--space-2xs);
		border-radius: var(--radius-pill);
		background: var(--color-error);
	}

	.dot.on {
		background: var(--color-success);
	}

	.rail-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		padding: var(--space-sm) var(--space-sm) var(--space-2xs);
		color: var(--color-neutral);
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.rail-actions {
		display: flex;
		gap: var(--space-2xs);
	}

	.stall-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2xs);
		margin-top: var(--space-xs);
	}

	.archive-browser-open {
		background: var(--color-paper-2);
		color: var(--color-ink);
	}

	.new,
	.settings-open,
	.mini,
	.stop,
	.attach,
	.send,
	.welcome-action {
		min-height: var(--control-height);
		border: var(--rule-hair) solid transparent;
		border-radius: var(--radius-input);
		cursor: pointer;
		font-weight: 600;
		white-space: nowrap;
		transition:
			background-color var(--dur-micro) var(--ease-out),
			transform var(--dur-micro) var(--ease-out);
	}

	.new,
	.settings-open {
		display: grid;
		place-items: center;
		width: var(--control-height);
		min-width: var(--control-height);
		padding: 0;
		background: var(--color-accent);
		color: var(--color-accent-ink);
	}

	.create {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin: var(--space-sm);
		padding: var(--space-sm);
		border-radius: var(--radius-card);
		background: var(--color-paper-3);
		color: var(--color-ink);
	}

	.create-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.create-heading h2 {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
		font-family: var(--font-display);
		font-size: var(--text-md);
		font-style: normal;
		font-weight: var(--display-weight);
		letter-spacing: var(--tracking-display);
		line-height: 1.15;
	}

	.create-row {
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
	}

	.create-row label {
		color: var(--color-neutral);
		font-size: var(--text-xs);
		font-weight: 600;
	}

	.cwd-input,
	.profile-input,
	textarea {
		width: 100%;
		min-width: 0;
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-input);
		outline: var(--rule-fine) solid transparent;
		outline-offset: var(--focus-offset);
		background: var(--color-paper);
		color: var(--color-ink);
	}

	.cwd-input,
	.profile-input {
		min-height: var(--control-height);
		padding-inline: var(--space-sm);
		font-size: var(--text-sm);
	}

	.cwd-input {
		font-family: var(--font-outlier);
	}

	.cwd-field {
		display: flex;
		gap: var(--space-3xs);
		min-width: 0;
	}

	.cwd-field .cwd-input {
		flex: 1;
		width: 1px;
	}

	.cwd-browse-trigger,
	.cwd-up {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		gap: var(--space-3xs);
		min-height: var(--control-height);
		padding-inline: var(--space-2xs);
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-input);
		background: var(--color-paper);
		color: var(--color-neutral);
		cursor: pointer;
		font-size: var(--text-xs);
		font-weight: 600;
	}

	.cwd-browse-trigger:disabled,
	.cwd-up:disabled {
		cursor: default;
		opacity: 0.48;
	}

	.cwd-browse-trigger svg,
	.cwd-directory svg {
		width: 1rem;
		height: 1rem;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.75;
	}

	.cwd-browser {
		display: flex;
		flex-direction: column;
		min-width: 0;
		max-height: 17rem;
		overflow: hidden;
		border: var(--rule-hair) solid var(--color-rule);
		border-radius: var(--radius-input);
		background: var(--color-paper);
		box-shadow: var(--shadow-card);
	}

	.cwd-browser-toolbar {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		min-width: 0;
		padding: var(--space-2xs);
		border-block-end: var(--rule-hair) solid var(--color-rule);
	}

	.cwd-up {
		width: var(--control-height-compact);
		min-height: var(--control-height-compact);
		padding: 0;
		font-size: var(--text-md);
	}

	.cwd-current {
		appearance: none;
		border: 0;
		padding: var(--space-3xs);
		background: transparent;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		color: var(--color-muted);
		cursor: pointer;
		font-family: var(--font-outlier);
		font-size: 0.68rem;
		text-align: start;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cwd-current:hover:not(:disabled),
	.cwd-current:focus-visible {
		color: var(--color-accent-active);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}

	.cwd-current:disabled {
		cursor: default;
	}

	.cwd-hidden-toggle {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		min-height: var(--control-height-compact);
		padding-inline: var(--space-xs);
		border-block-end: var(--rule-hair) solid var(--color-rule);
		color: var(--color-muted);
		cursor: pointer;
		font-size: var(--text-xs);
	}

	.cwd-hidden-toggle input {
		width: 1rem;
		height: 1rem;
		margin: 0;
		accent-color: var(--color-accent-active);
	}

	.cwd-directory-list {
		min-height: 0;
		overflow: auto;
		padding: var(--space-3xs);
	}

	.cwd-directory {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		width: 100%;
		min-height: var(--control-height-compact);
		padding: var(--space-3xs) var(--space-2xs);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-neutral);
		cursor: pointer;
		font-size: var(--text-sm);
		text-align: start;
	}

	.cwd-directory span:first-of-type {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cwd-browser-message {
		margin: 0;
		padding: var(--space-xs);
		color: var(--color-muted);
		font-size: var(--text-xs);
	}

	.cwd-browser-message.error {
		color: var(--color-error);
	}

	@media (hover: hover) and (pointer: fine) {
		.cwd-browse-trigger:hover,
		.cwd-up:hover:not(:disabled),
		.cwd-directory:hover {
			background: var(--color-paper-3);
			color: var(--color-ink);
		}
	}

	.cwd-input::placeholder,
	textarea::placeholder {
		color: var(--color-muted);
		opacity: 1;
	}

	.cwd-input:focus-visible,
	.profile-input:focus-visible,
	textarea:focus-visible {
		border-color: var(--color-rule-2);
		outline-color: var(--color-focus);
	}

	.cwd-input[aria-invalid='true'] {
		border-color: var(--color-error);
	}

	.cwd-input:disabled,
	.profile-input:disabled,
	textarea:disabled,
	button:disabled {
		opacity: 0.52;
		cursor: not-allowed;
	}

	.create-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
	}

	.mini {
		padding-inline: var(--space-sm);
		background: var(--color-accent);
		color: var(--color-accent-ink);
		font-size: var(--text-sm);
	}

	.mini.ghost {
		border-color: var(--color-rule-2);
		background: var(--color-paper);
		color: var(--color-neutral);
	}

	.mini.danger {
		border-color: var(--color-error);
		background: var(--color-error);
		color: var(--color-accent-ink);
	}

	.create-hint {
		display: block;
		min-height: 1lh;
		color: var(--color-muted);
		font-size: var(--text-xs);
		line-height: 1.45;
	}

	.create-err {
		min-height: 1lh;
		padding: var(--space-xs);
		border-radius: var(--radius-input);
		background: var(--color-error-soft);
		color: var(--color-error);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.sessions {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0 var(--space-2xs) var(--space-sm);
	}

	.session-row {
		position: relative;
		display: grid;
		grid-template-columns: var(--space-md) minmax(0, 1fr) auto;
		align-items: center;
		margin-block-end: var(--space-3xs);
	}

	.session-row.drop-target {
		border-radius: var(--radius-input);
		background: var(--color-hover);
		outline: 1px dashed var(--color-accent);
		outline-offset: -1px;
	}

	.session-drag-handle {
		display: grid;
		place-items: center;
		width: var(--space-md);
		height: var(--control-height-compact);
		padding: 0;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--color-faint);
		cursor: grab;
		touch-action: none;
	}

	.session-drag-handle:hover,
	.session-drag-handle:focus-visible {
		color: var(--color-ink);
		background: var(--color-hover);
	}

	.session-drag-handle:active { cursor: grabbing; }
	.session-drag-handle svg { width: 14px; height: 14px; fill: currentColor; }
	.session-drag-handle.has-progress {
		color: var(--color-accent-active);
	}
	.session-progress-percent {
		font-family: var(--font-outlier);
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: -0.035em;
		line-height: 1;
		white-space: nowrap;
	}

	.session {
		position: relative;
		display: grid;
		grid-template-columns: var(--space-xs) minmax(0, 1fr) auto;
		gap: var(--space-2xs);
		align-items: center;
		width: 100%;
		min-height: var(--control-height-compact);
		padding: var(--space-3xs) var(--space-xs);
		border: var(--rule-hair) solid transparent;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--color-muted);
		text-align: start;
		text-decoration: none;
		white-space: nowrap;
		cursor: grab;
		user-select: none;
		transition: background-color var(--dur-micro) var(--ease-out);
	}

	.session.dragging { cursor: grabbing; }

	.session.active {
		border-color: var(--color-rule);
		background: var(--color-paper);
		color: var(--color-ink);
	}

	.run-dot {
		background: var(--color-success);
	}

	.run-dot.running {
		background: var(--color-warning);
		animation: pulse-status 1.8s var(--ease-in-out) infinite;
	}

	.run-dot.error {
		background: var(--color-error);
		animation: none;
	}

	.run-dot.interrupted {
		background: var(--color-warning);
		animation: none;
	}

	.session .label {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		grid-column: 2;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-sm);
		font-weight: 500;
	}

	.needs-input-indicator {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--space-sm);
		height: var(--space-sm);
		border-radius: var(--radius-pill);
		background: var(--color-error);
		color: var(--color-paper);
		font-size: var(--text-xs);
		font-weight: 800;
		line-height: 1;
	}

	.needs-input-indicator.choice {
		background: var(--color-warning);
		color: var(--color-paper);
	}

	.session-finished-indicator {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1rem;
		height: 1rem;
		border-radius: var(--radius-pill);
		background: var(--color-success-soft);
		color: var(--color-success);
	}

	.session-finished-indicator svg {
		width: 0.75rem;
		height: 0.75rem;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 2;
	}

	.session-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.session-interrupted {
		flex: none;
		padding: 0 var(--space-3xs);
		border-radius: var(--radius-pill);
		background: var(--color-warning-soft);
		color: var(--color-neutral);
		font-size: var(--text-xs);
		font-weight: 600;
	}

	.session-interrupted.checking {
		background: var(--color-paper-3);
		color: var(--color-muted);
	}

	.fast-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--space-sm);
		height: var(--space-sm);
		color: var(--color-warning);
		line-height: 1;
	}

	.fast-mark svg {
		width: var(--space-sm);
		height: var(--space-sm);
		fill: currentColor;
	}

	.session .host-badge {
		max-width: 6.5rem;
		overflow: hidden;
		padding-inline: var(--space-2xs);
		border: var(--rule-hair) solid var(--color-rule);
		border-radius: var(--radius-pill);
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
		line-height: 1.6;
		color: var(--color-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session-row.side-row .session {
		width: 100%;
	}

	.session-row.side-row {
		padding-inline-start: var(--space-md);
		grid-template-columns: minmax(0, 1fr) auto;
	}

	.session.side .label {
		color: var(--color-neutral);
	}

	.empty {
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
		padding: var(--space-lg) var(--space-sm);
		color: var(--color-muted);
		font-size: var(--text-sm);
	}

	.empty strong {
		color: var(--color-ink-2);
		font-weight: 600;
	}

	.hint {
		display: flex;
		justify-content: flex-start;
		gap: var(--space-sm);
		padding: var(--space-xs) var(--space-sm) calc(var(--space-xs) + env(safe-area-inset-bottom));
		border-block-start: var(--rule-hair) solid var(--color-rule);
		color: var(--color-muted);
		font-size: var(--text-xs);
	}

	.chat {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		background: var(--color-paper);
		color: var(--color-ink);
	}

	.workspace-split {
		display: grid;
		flex: 1;
		grid-template-columns: minmax(0, 1fr);
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.workspace-split.inspector-open {
		grid-template-columns: minmax(15rem, var(--workspace-split)) var(--space-2xs) minmax(0, 1fr);
	}

	.workspace-pane,
	.conversation-pane {
		position: relative;
		min-width: 0;
		min-height: 0;
	}

	.workspace-pane {
		overflow: hidden;
		border-inline-end: var(--rule-hair) solid var(--color-rule);
		background: var(--color-paper-2);
	}

	.workspace-pane[hidden] { display: none; }

	.conversation-pane {
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.workspace-resizer {
		position: relative;
		z-index: 2;
		width: var(--space-2xs);
		background: var(--color-paper-3);
		cursor: col-resize;
		touch-action: none;
		user-select: none;
	}

	.workspace-resizer::after {
		position: absolute;
		inset-block: 0;
		inset-inline-start: 50%;
		width: 1px;
		background: var(--color-rule-2);
		content: '';
	}

	.workspace-resizer:hover,
	.workspace-resizer:focus-visible {
		background: var(--color-accent-soft);
		outline: none;
	}

	.workspace-resizer:focus-visible::after { background: var(--color-accent); }

	@media (max-width: 59.999rem) {
		.workspace-split.inspector-open {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: minmax(10rem, var(--workspace-split)) var(--space-2xs) minmax(0, 1fr);
		}

		.workspace-pane {
			border-inline-end: 0;
			border-block-end: var(--rule-hair) solid var(--color-rule);
		}

		.workspace-resizer {
			width: auto;
			cursor: row-resize;
		}

		.workspace-resizer::after {
			inset-block: 50% auto;
			inset-inline: 0;
			width: auto;
			height: 1px;
		}
	}

	.welcome {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-xl);
		width: min(100%, var(--measure-reading));
		max-height: 100%;
		/* Block-auto margins center the welcome in the viewport; they collapse
		   to 0 when the content is taller than the screen. */
		margin: auto;
		padding: calc(var(--space-2xl) + env(safe-area-inset-top)) var(--space-md) var(--space-xl);
		overflow-y: auto;
	}

	.welcome-copy {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-sm);
		min-width: 0;
	}

	.welcome h1 {
		margin: 0;
		min-width: 0;
		max-width: 11ch;
		overflow-wrap: anywhere;
		font-family: var(--font-display);
		font-size: clamp(var(--text-2xl), 10vw, var(--text-display));
		font-style: normal;
		font-weight: var(--display-weight);
		letter-spacing: var(--tracking-display);
		line-height: 0.98;
	}

	.welcome-copy p {
		margin: 0;
		max-width: var(--measure-lede);
		color: var(--color-neutral);
		font-size: var(--text-base);
		line-height: 1.5;
	}

	.welcome-action {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		padding-inline: var(--space-md);
		background: var(--color-accent);
		color: var(--color-accent-ink);
	}

	.welcome-action span {
		font-size: var(--text-md);
	}

	.welcome-details {
		align-self: end;
		border-block-start: var(--rule-hair) solid var(--color-rule-2);
	}

	.welcome-details > div {
		display: grid;
		grid-template-columns: minmax(7rem, 0.42fr) minmax(0, 1fr);
		gap: var(--space-sm);
		padding-block: var(--space-sm);
		border-block-end: var(--rule-hair) solid var(--color-rule);
	}

	.welcome-details strong {
		color: var(--color-ink-2);
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.welcome-details span {
		color: var(--color-muted);
		font-size: var(--text-sm);
		line-height: 1.45;
	}

	.topbar {
		position: relative;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-2xs);
		padding: calc(var(--space-3xs) + env(safe-area-inset-top)) var(--space-2xs) var(--space-3xs);
		border-block-end: var(--rule-hair) solid var(--color-rule);
		background: var(--color-paper);
	}

	.original-prompt {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		min-width: 0;
		padding: 0.4rem var(--space-sm);
		border-block-end: var(--rule-hair) solid var(--color-rule);
		background: var(--color-paper-2);
	}

	.original-prompt > span {
		flex: 0 0 auto;
		color: var(--color-muted);
		font-family: var(--font-outlier);
		font-size: var(--text-2xs);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.todo-position {
		flex: 0 0 auto;
		color: var(--color-accent-active);
		font-family: var(--font-outlier);
		font-size: var(--text-2xs);
		font-variant-numeric: tabular-nums;
	}

	.agent-duration,
	.agent-usage,
	.working-duration {
		color: var(--color-muted);
		font-size: var(--text-2xs);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.thinking-cost { font-size: var(--text-xs); }
	.task-cost { font-variant-numeric: tabular-nums; }

	.original-prompt p {
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
		overflow: hidden;
		color: var(--color-ink-2);
		font-size: var(--text-xs);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session-bar-right {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-sm);
		min-width: 0;
		margin-inline-start: auto;
	}

	.session-progress {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		color: var(--color-muted);
		font-size: var(--text-2xs);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.session-progress-meter {
		width: 2.6rem;
		height: 0.3rem;
		overflow: hidden;
		border-radius: 999px;
		background: var(--color-rule);
	}

	.session-progress-meter > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--color-accent);
		transition: width 180ms ease;
	}

	.usage-limits {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		max-width: 100%;
		color: var(--color-muted);
		font-family: var(--font-outlier);
		font-size: var(--text-2xs);
		line-height: 1.35;
		white-space: nowrap;
	}

	.usage-window {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-3xs);
	}

	.usage-window strong {
		color: var(--color-ink-2);
		font-weight: 600;
	}

	.usage-details { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }

	.session-heading {
		min-width: 0;
	}

	.session-title-row {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		min-width: 0;
	}

	.session-heading h1 {
		flex: 0 1 auto;
		margin: 0;
		min-width: 0;
		overflow: hidden;
		overflow-wrap: anywhere;
		color: var(--color-ink);
		font-family: var(--font-body);
		font-size: var(--text-sm);
		font-style: normal;
		font-weight: 600;
		letter-spacing: normal;
		line-height: 1.25;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rename-session {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: var(--control-height-compact);
		height: var(--control-height-compact);
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-muted);
		cursor: pointer;
	}

	.rename-session:hover,
	.rename-session:focus-visible {
		background: var(--color-paper-3);
		color: var(--color-ink);
	}

	.rename-session svg {
		width: var(--space-sm);
		height: var(--space-sm);
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.75;
	}

	.session-meta {
		display: none;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2xs) var(--space-xs);
		margin-block-start: var(--space-2xs);
		color: var(--color-muted);
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
	}

	.session-facts {
		display: none;
		grid-column: 1 / -1;
		align-items: center;
		gap: var(--space-2xs);
		min-width: 0;
		overflow: hidden;
		color: var(--color-neutral);
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.fact {
		display: inline-flex;
		align-items: baseline;
		min-width: 0;
	}

	.fact + .fact::before {
		content: '·';
		margin-inline-end: var(--space-2xs);
		color: var(--color-rule-2);
	}

	.fact-detail {
		color: var(--color-muted);
	}

	.fact.profile {
		color: var(--color-accent-active);
	}

	.fact.host {
		font-family: var(--font-outlier);
		color: var(--color-muted);
	}

	.fact.host.degraded {
		color: var(--color-warning);
	}

	.topbar .tid,
	.topbar .meta {
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.topbar .tid {
		color: var(--color-neutral);
	}

	.topbar .tid.dim,
	.topbar .meta-sep,
	.topbar .meta {
		color: var(--color-muted);
	}

	/* The cwd keeps its natural width so the agent row sits right beside it. */

	.session-state {
		display: flex;
		align-items: center;
		gap: var(--space-3xs);
		justify-self: end;
	}

	.theme-toggle {
		display: grid;
		place-items: center;
		width: var(--control-height);
		min-width: var(--control-height);
		height: var(--control-height);
		padding: 0;
		border: var(--rule-hair) solid transparent;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--color-neutral);
		cursor: pointer;
		transition:
			background-color var(--dur-micro) var(--ease-out),
			color var(--dur-micro) var(--ease-out),
			transform var(--dur-micro) var(--ease-out);
	}

	.theme-toggle svg {
		display: block;
		width: var(--space-md);
		height: var(--space-md);
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.75;
	}

	.welcome-theme {
		position: fixed;
		inset-block-start: calc(var(--space-3xs) + env(safe-area-inset-top));
		inset-inline-end: var(--space-xs);
		z-index: var(--z-toast);
		border-color: var(--color-rule);
		background: var(--color-paper);
		box-shadow: var(--shadow-card);
	}

	.files-trigger,
	.session-info-trigger,
	.session-info-close {
		display: grid;
		place-items: center;
		width: var(--control-height);
		min-width: var(--control-height);
		height: var(--control-height);
		padding: 0;
		border: var(--rule-hair) solid transparent;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--color-neutral);
		cursor: pointer;
		transition:
			background-color var(--dur-micro) var(--ease-out),
			transform var(--dur-micro) var(--ease-out);
	}

	.files-trigger[aria-pressed='true'] {
		border-color: var(--color-rule);
		background: var(--color-paper-3);
		color: var(--color-ink);
	}

	.session-info-trigger {
		position: relative;
	}

	.files-trigger svg,
	.session-info-trigger svg,
	.session-info-close svg {
		display: block;
		width: var(--space-md);
		height: var(--space-md);
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.75;
	}

	.session-info-trigger .info-dot {
		fill: currentColor;
		stroke: none;
	}

	.session-state-dot {
		position: absolute;
		inset-block-start: var(--space-2xs);
		inset-inline-end: var(--space-2xs);
		width: var(--space-2xs);
		height: var(--space-2xs);
		border: var(--rule-hair) solid var(--color-paper);
		border-radius: var(--radius-pill);
		background: var(--color-success);
	}

	.session-state-dot.running {
		background: var(--color-warning);
		animation: pulse-status 1.8s var(--ease-in-out) infinite;
	}

	.session-state-dot.error {
		background: var(--color-error);
		animation: none;
	}

	.session-state-dot.interrupted {
		background: var(--color-warning);
		animation: none;
	}

	.stop {
		display: grid;
		place-items: center;
		width: var(--control-height);
		min-width: var(--control-height);
		min-height: var(--control-height);
		padding: 0;
		border-color: var(--color-error);
		background: var(--color-paper);
		color: var(--color-error);
	}

	.stop.play {
		border-color: var(--color-success);
		color: var(--color-success);
	}

	.stop-icon {
		display: block;
		width: var(--space-sm);
		height: var(--space-sm);
		fill: currentColor;
	}

	.play-icon {
		display: block;
		width: var(--space-sm);
		height: var(--space-sm);
		fill: currentColor;
	}

	.session-info-dialog,
	.archive-browser-dialog {
		position: fixed;
		inset: 0;
		width: min(calc(100% - var(--space-lg)), 40rem);
		max-width: none;
		max-height: calc(100dvh - var(--space-xl));
		margin: auto;
		padding: 0;
		overflow: auto;
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-card);
		background: var(--color-paper);
		box-shadow: var(--shadow-card);
		color: var(--color-ink);
	}

	.session-info-dialog::backdrop,
	.archive-browser-dialog::backdrop {
		background: var(--color-overlay);
	}

	.archive-browser-panel { padding: var(--space-sm); }

	.archive-browser-panel .session-info-heading { margin-block-end: var(--space-sm); }

	.archive-browser-list {
		display: grid;
		max-height: min(65dvh, 38rem);
		overflow: auto;
		border-block-start: var(--rule-hair) solid var(--color-rule);
	}

	.archive-browser-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		padding: var(--space-xs) 0;
		border-block-end: var(--rule-hair) solid var(--color-rule);
	}

	.archive-browser-copy {
		display: grid;
		gap: var(--space-3xs);
		min-width: 0;
	}

	.archive-browser-copy strong,
	.archive-browser-copy span,
	.archive-browser-copy small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.archive-browser-copy span { color: var(--color-muted); font-size: var(--text-xs); }
	.archive-browser-copy small { color: var(--color-muted); font-size: var(--text-2xs); }
	.archive-browser-row .mini { flex: none; }

	.archive-browser-actions {
		display: flex;
		flex: none;
		gap: var(--space-2xs);
	}

	.archive-delete {
		border-color: var(--color-error);
		background: var(--color-error);
		color: var(--color-paper);
	}

	.archive-delete:hover:not(:disabled) {
		background: var(--color-error-strong, var(--color-error));
		color: var(--color-paper);
	}

	.archive-browser-empty {
		margin: var(--space-sm) 0 0;
		color: var(--color-muted);
		font-size: var(--text-sm);
	}

	.archive-browser-empty.error { color: var(--color-error); }

	.interactive-choice-dialog {
		position: fixed;
		inset: 0;
		width: min(calc(100% - var(--space-lg)), 34rem);
		max-width: none;
		max-height: calc(100dvh - var(--space-xl));
		margin: auto;
		padding: 0;
		overflow: auto;
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-card);
		background: var(--color-paper);
		box-shadow: var(--shadow-card);
		color: var(--color-ink);
	}

	.interactive-choice-dialog::backdrop { background: var(--color-overlay); }

	.interactive-choice-panel { padding: var(--space-sm); }

	.interactive-choice-panel > p {
		margin: var(--space-sm) 0;
		color: var(--color-ink-2);
		white-space: pre-wrap;
	}

	.interactive-choice-options {
		display: grid;
		gap: var(--space-2xs);
	}

	.interactive-choice-option {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		min-height: var(--control-height);
		padding: var(--space-xs) var(--space-sm);
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-input);
		background: var(--color-paper-2);
		color: var(--color-ink);
		text-align: start;
		cursor: pointer;
	}

	.interactive-choice-option:hover,
	.interactive-choice-option:focus-visible {
		border-color: var(--color-accent);
		background: var(--color-paper-3);
	}

	.interactive-choice-option > span {
		display: grid;
		place-items: center;
		flex: none;
		width: var(--space-md);
		height: var(--space-md);
		border-radius: var(--radius-pill);
		background: var(--color-paper-3);
		color: var(--color-muted);
		font-size: var(--text-xs);
	}

	.interactive-choice-other {
		display: grid;
		justify-items: start;
		gap: var(--space-2xs);
		margin-block-start: var(--space-sm);
		padding-block-start: var(--space-sm);
		border-block-start: var(--rule-hair) solid var(--color-rule);
	}

	.interactive-choice-other label {
		color: var(--color-muted);
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.interactive-choice-other textarea {
		width: 100%;
		min-height: calc(var(--control-height) * 1.6);
		padding: var(--space-xs);
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-input);
		background: var(--color-paper-2);
		color: var(--color-ink);
		font: inherit;
		resize: vertical;
	}

	.session-info-panel {
		padding: var(--space-sm);
	}

	.session-remove-action { width: 100%; min-height: var(--control-height); margin-block-start: var(--space-sm); padding-inline: var(--space-sm); border: var(--rule-hair) solid color-mix(in srgb, var(--color-error) 38%, var(--color-rule)); border-radius: var(--radius-input); background: transparent; color: var(--color-error); cursor: pointer; font: inherit; text-align: center; }
	.session-remove-action:hover { background: color-mix(in srgb, var(--color-error) 8%, var(--color-paper)); }
	.session-detail-actions { display: flex; flex-wrap: wrap; gap: var(--space-xs); margin-block-start: var(--space-sm); }
	.session-detail-actions > button { flex: 1; width: auto; margin-block-start: 0; }
	.session-clear-action { min-height: var(--control-height); padding-inline: var(--space-sm); border: var(--rule-hair) solid var(--color-rule-2); border-radius: var(--radius-input); background: var(--color-paper-2); color: var(--color-ink); cursor: pointer; font: inherit; text-align: center; }
	.session-clear-action:enabled:hover { background: var(--color-paper-3); border-color: var(--color-accent); }
	.session-clear-action:enabled:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
	.session-detail-actions > button:disabled { opacity: .5; cursor: default; }

	.session-info-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		padding-block-end: var(--space-xs);
		border-block-end: var(--rule-hair) solid var(--color-rule);
	}

	.session-info-heading h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-style: normal;
		font-weight: var(--display-weight);
		letter-spacing: var(--tracking-display);
		line-height: 1.1;
	}

	.session-info-list {
		margin: 0;
	}

	.session-info-list > div {
		display: grid;
		grid-template-columns: minmax(5rem, 0.35fr) minmax(0, 1fr);
		gap: var(--space-sm);
		padding-block: var(--space-2xs);
		border-block-end: var(--rule-hair) solid var(--color-rule);
	}

	.session-info-list > div:last-child {
		border-block-end: 0;
	}

	.session-info-list dt,
	.session-info-list dd {
		margin: 0;
		font-size: var(--text-sm);
		line-height: 1.45;
	}

	.session-info-list dt {
		color: var(--color-muted);
		font-family: var(--font-body);
		font-weight: 500;
	}

	.session-info-list dd {
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--color-ink-2);
		font-family: var(--font-outlier);
	}

	.side-banner,
	.goal-tracker {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-2xs) var(--space-sm);
		border-block-end: var(--rule-hair) solid var(--color-rule);
		font-size: var(--text-xs);
	}

	.goal-dismiss {
		display: grid;
		place-items: center;
		flex: none;
		width: var(--control-height-compact);
		height: var(--control-height-compact);
		margin-inline-start: auto;
		padding: 0;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--color-muted);
		cursor: pointer;
	}

	.goal-dismiss svg { width: var(--space-sm); height: var(--space-sm); fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 2; }
	.goal-dismiss:hover { background: var(--color-paper-3); color: var(--color-ink); }

	.side-banner {
		background: var(--color-warning-soft);
		color: var(--color-neutral);
	}

	.side-banner-label {
		font-weight: 600;
	}

	.side-banner .meta {
		color: var(--color-muted);
	}

	/* Sub-agent transcripts: quiet links in the header meta row. */
	.agent-row {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--space-2xs) var(--space-xs);
		align-items: center;
		min-width: 0;
	}

	.agent-link {
		display: inline-flex;
		align-items: center;
		gap: var(--space-3xs);
		max-width: 12rem;
		padding: 0;
		overflow: hidden;
		border: 0;
		background: transparent;
		color: var(--color-ink-2);
		cursor: pointer;
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
		line-height: 1.45;
		text-decoration-color: transparent;
		text-decoration-line: underline;
		text-decoration-thickness: 1px;
		text-overflow: ellipsis;
		text-underline-offset: 0.2em;
		white-space: nowrap;
		transition:
			color var(--dur-micro) var(--ease-out),
			text-decoration-color var(--dur-micro) var(--ease-out);
	}

	.agent-link:hover,
	.agent-link:focus-visible {
		color: var(--color-focus);
		text-decoration-color: var(--color-accent);
	}

	.agent-link.current {
		color: var(--color-accent-active);
		font-weight: 600;
		text-decoration-color: var(--color-accent);
	}

	.agent-link.closed {
		color: var(--color-muted);
	}

	.agent-history-group {
		position: relative;
		min-width: 0;
	}

	.agent-history-group summary {
		color: var(--color-muted);
		cursor: pointer;
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
		line-height: 1.45;
		white-space: nowrap;
	}

	.agent-history-list {
		position: absolute;
		z-index: 5;
		top: calc(100% + var(--space-2xs));
		right: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
		min-width: 12rem;
		max-width: min(20rem, calc(100vw - 2rem));
		max-height: min(24rem, 65vh);
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: var(--space-2xs);
		border: 1px solid var(--color-rule-2);
		border-radius: var(--radius-sm);
		background: var(--color-paper-3);
		box-shadow: var(--shadow-popover);
	}

	.agent-history-list .agent-link {
		flex: 0 0 auto;
		width: 100%;
		max-width: none;
		min-height: var(--control-height-compact);
	}

	.agent-dot {
		flex: none;
		width: var(--space-3xs);
		height: var(--space-3xs);
		border-radius: var(--radius-pill);
		background: var(--color-rule-2);
	}

	.agent-dot.running {
		background: var(--color-success);
		animation: pulse-status 1.8s var(--ease-in-out) infinite;
	}

	.agent-menu-role {
		color: var(--color-muted);
		font-weight: 400;
	}

	/* Read-only agent view: the composer yields to a quiet return strip. */
	.agent-banner {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2xs) var(--space-xs);
		align-items: center;
		padding: var(--space-xs) var(--space-sm) calc(var(--space-xs) + env(safe-area-inset-bottom));
		border-block-start: var(--rule-hair) solid var(--color-rule);
		background: var(--color-paper-2);
		color: var(--color-neutral);
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
	}

	.agent-banner-label {
		display: inline-flex;
		flex-wrap: wrap;
		gap: var(--space-3xs);
		align-items: baseline;
		min-width: 0;
		font-weight: 600;
	}

	.spacer {
		flex: 1;
	}

	.goal-tracker {
		flex-direction: column;
		align-items: stretch;
		background: var(--color-accent-soft);
		color: var(--color-ink);
	}

	.goal-main,
	.goal-metrics {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		min-width: 0;
	}

	.goal-marker {
		color: var(--color-accent-active);
	}

	.goal-objective {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.goal-state {
		padding: var(--space-3xs) var(--space-xs);
		border: var(--rule-hair) solid var(--color-accent);
		border-radius: var(--radius-pill);
		color: var(--color-accent-active);
		font-size: var(--text-xs);
		font-weight: 600;
		white-space: nowrap;
	}

	.goal-metrics {
		flex-wrap: wrap;
		color: var(--color-neutral);
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}

	.goal-progress {
		flex: 1;
		min-width: 7rem;
		height: var(--space-2xs);
		overflow: hidden;
		border-radius: var(--radius-pill);
		background: var(--color-rule);
	}

	.goal-progress span {
		display: block;
		height: 100%;
		background: var(--color-accent-active);
	}

	.conflict {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		margin: var(--space-sm);
		padding: var(--space-sm);
		border: var(--rule-hair) solid var(--color-error);
		border-radius: var(--radius-card);
		background: var(--color-error-soft);
		color: var(--color-ink);
	}

	.conflict-head {
		color: var(--color-error);
		font-family: var(--font-display);
		font-size: var(--text-md);
		font-style: normal;
		font-weight: var(--display-weight);
		letter-spacing: var(--tracking-display);
	}

	.conflict-body {
		max-width: var(--measure-prose);
		color: var(--color-neutral);
		font-size: var(--text-sm);
		line-height: 1.5;
	}

	.conflict-body code {
		color: var(--color-error);
		font-family: var(--font-outlier);
		overflow-wrap: anywhere;
	}

	.conflict-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}

	.transcript {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-anchor: none;
		padding: var(--space-xs) var(--space-sm) var(--space-lg);
		scroll-padding-block-end: var(--space-lg);
	}

	.transcript-frame {
		padding-top: 2rem;
		position: relative;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
	.activity-toolbar { position: absolute; top: 0; right: var(--space-sm); z-index: 1; font-size: var(--text-xs); color: var(--color-muted); }
	.activity-toolbar label { display: flex; align-items: center; gap: var(--space-xs); min-height: 2rem; cursor: pointer; }
	.item.compact-activity { display: block; min-width: 0; padding-block: var(--space-2xs); }
	.relay-block { display: grid; gap: var(--space-2xs); margin-block: var(--space-2xs); }
	.relay-frame { border-left: 2px solid var(--color-rule); padding-left: var(--space-xs); }
	.relay-meta { color: var(--color-muted); font-size: var(--text-xs); }
	.relay-text { white-space: pre-wrap; overflow-wrap: anywhere; }
	.relay-notice summary { cursor: pointer; color: var(--color-muted); }
	.relay-notice .relay-text { margin-top: var(--space-2xs); }
	.activity-group-toggle { display: flex; align-items: center; gap: var(--space-xs); padding: var(--space-2xs) var(--space-xs); border: none; border-radius: var(--radius-input); background: transparent; color: var(--color-muted); font: inherit; font-size: var(--text-xs); cursor: pointer; }
	.activity-group-toggle:hover { background: var(--color-paper-3); color: var(--color-ink); }
	.activity-group-toggle { min-width: 0; max-width: 100%; text-align: start; }
	.activity-group-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.activity-group-toggle:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }

	.transcript-frame.has-position-rail .transcript {
		padding-inline-end: calc(var(--space-sm) + 1.25rem);
	}

	.transcript-position {
		position: absolute;
		z-index: var(--z-raised);
		inset-block: var(--space-sm) var(--space-lg);
		inset-inline-end: 0;
		width: 1.25rem;
		pointer-events: none;
	}

	.transcript-position button {
		position: absolute;
		inset-inline-end: 0;
		display: grid;
		place-items: center;
		width: 1.25rem;
		height: 1rem;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		pointer-events: auto;
		transform: translateY(-50%);
	}

	.transcript-position button span {
		display: block;
		width: 9px;
		height: 3px;
		border-radius: var(--radius-pill);
		background: var(--color-rule-2);
		transition: width var(--dur-micro) var(--ease-out), background-color var(--dur-micro) var(--ease-out);
	}

	.transcript-position button:hover span,
	.transcript-position button:focus-visible span,
	.transcript-position button.active span {
		width: 15px;
		background: var(--color-accent-active);
	}

	.transcript-position button:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: 1px;
	}

	.activity-jump {
		position: relative;
		z-index: var(--z-raised);
		display: flex;
		height: 0;
		justify-content: center;
	}

	.new-activity {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2xs);
		min-height: var(--control-height-compact);
		padding-inline: var(--space-xs);
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-pill);
		background: var(--color-paper);
		box-shadow: var(--shadow-card);
		color: var(--color-neutral);
		cursor: pointer;
		font-size: var(--text-xs);
		font-weight: 600;
		transform: translateY(calc(-100% - var(--space-2xs)));
		transition:
			background-color var(--dur-micro) var(--ease-out),
			transform var(--dur-micro) var(--ease-out);
	}

	.new-activity svg {
		width: var(--space-sm);
		height: var(--space-sm);
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.75;
	}

	.transcript-spacer {
		flex: none;
	}

	.virtual-row,
	.transcript > .item,
	.sys {
		width: min(100%, var(--measure-reading));
		margin-inline: auto;
	}

	.virtual-row {
		padding-block-end: var(--space-xs);
	}

	/* Agent messages already end with their compact meta row, so their
	   wrapper needs less trailing space than other transcript rows. */
	.virtual-row:has(> .item.agent) {
		padding-block-end: var(--space-2xs);
	}

	.sys {
		padding-block-end: var(--space-xs);
		color: var(--color-muted);
		font-size: var(--text-sm);
	}

	.transcript-empty {
		display: grid;
		align-content: center;
		justify-items: center;
		gap: var(--space-2xs);
		width: min(100%, var(--measure-reading));
		min-height: 100%;
		margin-inline: auto;
		padding-block-end: var(--space-2xl);
		text-align: center;
	}

	.transcript-empty p {
		margin: 0;
	}

	.transcript-empty-lede {
		color: var(--color-ink-2);
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: var(--display-weight);
		letter-spacing: var(--tracking-display);
	}

	.transcript-empty-hint {
		max-width: var(--measure-lede);
		color: var(--color-muted);
		font-size: var(--text-sm);
		line-height: 1.5;
	}

	.transcript-empty-hint strong {
		color: var(--color-neutral);
		font-weight: 600;
	}

	.transcript-empty-hint code {
		padding: 0 var(--space-3xs);
		border: var(--rule-hair) solid var(--color-rule);
		border-radius: var(--radius-xs);
		background: var(--color-paper-2);
		font-family: var(--font-outlier);
		font-size: 0.85em;
	}

	.item {
		display: grid;
		grid-template-columns: var(--space-sm) minmax(0, 1fr);
		gap: var(--space-2xs);
		align-items: start;
		min-width: 0;
	}

	.body {
		min-width: 0;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.item.user {
		display: block;
		/* Size to the prompt, matching the agent's prose measure, instead of
		   stretching a short line across the full reading column. */
		width: fit-content;
		min-width: min(100%, 16rem);
		max-width: min(100%, var(--measure-prose));
		padding: var(--space-xs) var(--space-sm);
		border-radius: var(--radius-input);
		background: var(--color-paper-3);
		color: var(--color-ink);
	}

	.item.agent {
		grid-template-columns: minmax(0, 1fr);
		gap: 0;
		/* The meta row supplies the trailing whitespace; no extra padding. */
		padding: var(--space-3xs) var(--space-sm) 0;
		color: var(--color-ink);
	}

	.agent-raw {
		margin: 0;
		overflow-wrap: anywhere;
		color: var(--color-ink-2);
		font-family: var(--font-outlier);
		font-size: var(--text-sm);
		line-height: 1.55;
		white-space: pre-wrap;
	}

	/* Message footer: timestamp, task usage, then quiet controls. */
	.agent-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2xs);
		justify-self: start;
		min-height: calc(var(--space-sm) + var(--space-3xs));
	}

	.message-progress {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		width: fit-content;
		max-width: 100%;
		margin-block-start: var(--space-xs);
		color: var(--color-muted);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.message-progress-label {
		font-weight: 500;
	}

	.message-progress strong {
		color: var(--color-ink-2);
		font-weight: 500;
	}

	.message-progress-meter {
		width: 2rem;
		height: 0.22rem;
		overflow: hidden;
		border-radius: 999px;
		background: var(--color-rule);
	}

	.message-progress-meter > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--color-accent);
		transition: width 180ms ease;
	}

	.agent-time {
		color: var(--color-muted);
		font-family: var(--font-body);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
	}

	.raw-toggle {
		display: grid;
		place-items: center;
		width: calc(var(--space-sm) + var(--space-3xs));
		height: calc(var(--space-sm) + var(--space-3xs));
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-muted);
		cursor: pointer;
		transition:
			background-color var(--dur-micro) var(--ease-out),
			color var(--dur-micro) var(--ease-out),
			opacity var(--dur-micro) var(--ease-out);
	}

	.copy-agent {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-3xs);
		min-height: calc(var(--space-sm) + var(--space-3xs));
		padding: 0 var(--space-2xs);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-muted);
		cursor: pointer;
		font: inherit;
		font-size: var(--text-xs);
		transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out);
	}

	.copy-agent:hover,
	.copy-agent:focus-visible {
		background: var(--color-paper-3);
		color: var(--color-ink);
	}

	.copy-agent svg {
		width: var(--space-xs);
		height: var(--space-xs);
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.75;
	}

	.raw-toggle svg {
		display: block;
		width: var(--space-xs);
		height: var(--space-xs);
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.75;
	}

	.raw-toggle[aria-pressed='true'] {
		background: var(--color-paper-3);
		color: var(--color-neutral);
	}

	.item.agent .body {
		width: 100%;
		max-width: none;
		font-family: var(--font-display);
		font-size: var(--text-md);
		font-style: normal;
		font-weight: var(--display-weight);
		letter-spacing: -0.01em;
		line-height: 1.45;
	}

	.markdown-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
		min-width: 0;
		white-space: normal;
	}

	.markdown-body p,
	.markdown-body ul,
	.markdown-body ol,
	.markdown-body blockquote,
	.markdown-body pre,
	.markdown-body table {
		margin: 0;
	}

	.markdown-heading {
		display: flex;
		align-items: baseline;
		gap: var(--space-2xs);
		font-size: inherit;
		line-height: inherit;
	}

	.markdown-heading strong,
	.markdown-body strong,
	.markdown-body th {
		font-weight: 700;
	}

	.markdown-hash {
		flex: none;
		color: var(--color-muted);
		font-family: inherit;
		font-size: inherit;
		font-weight: 700;
		letter-spacing: 0;
	}

	.markdown-body ul,
	.markdown-body ol {
		display: flex;
		flex-direction: column;
		gap: var(--space-3xs);
		padding-inline-start: var(--space-md);
	}

	.markdown-body li {
		padding-inline-start: var(--space-3xs);
	}

	/* Task-list items: the checkbox replaces the bullet, GitHub-style. */
	.markdown-body li.task {
		list-style: none;
	}

	.markdown-body li > p {
		display: inline;
	}

	.markdown-body input[type='checkbox'] {
		margin: 0 var(--space-2xs) 0 0;
		accent-color: var(--color-accent-active);
		vertical-align: middle;
	}

	.markdown-body blockquote {
		padding-inline-start: var(--space-sm);
		border-inline-start: var(--rule-hair) solid var(--color-rule-2);
		color: var(--color-neutral);
	}

	.markdown-body :not(pre) > code {
		padding: 0 var(--space-3xs);
		border-radius: var(--radius-sm);
		background: var(--color-paper-3);
		font-family: var(--font-outlier);
		font-size: 0.78em;
	}

	/* Code spans that resolve to workspace files open the file browser. */
	.markdown-body .code-path {
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
		font: inherit;
		text-align: start;
	}

	.markdown-body .file-link-actions { position: relative; display: inline-flex; align-items: baseline; gap: 0.15rem; }
	.markdown-body .file-link-copy { padding: 0 0.15rem; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--color-muted); cursor: pointer; font: inherit; font-size: 0.8em; vertical-align: baseline; }
	.markdown-body .file-link-copy:hover, .markdown-body .file-link-copy:focus-visible { color: var(--color-accent-active); background: var(--color-paper-3); }
	.markdown-body .file-link-preview { position: absolute; z-index: 20; inset-block-start: calc(100% + 0.35rem); inset-inline-start: 0; width: min(34rem, 75vw); max-height: 19rem; padding: var(--space-xs); overflow: hidden; border: var(--rule-hair) solid var(--color-rule-2); border-radius: var(--radius-input); background: var(--color-paper); box-shadow: var(--shadow-popover); color: var(--color-ink-2); pointer-events: none; }
	.markdown-body .file-link-preview strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-xs); }
	.markdown-body .file-link-preview pre { max-height: 15rem; margin: var(--space-3xs) 0 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-outlier); font-size: var(--text-2xs); }

	.markdown-body .code-path code {
		text-decoration: underline;
		text-decoration-color: var(--color-rule-2);
		text-decoration-thickness: var(--rule-hair);
		text-underline-offset: var(--space-3xs);
		transition: color var(--dur-micro) var(--ease-out);
	}

	.markdown-body .code-path:hover code,
	.markdown-body .code-path:focus-visible code {
		color: var(--color-accent-active);
		text-decoration-color: currentColor;
	}

	.markdown-code {
		display: flex;
		flex-direction: column;
		gap: 0;
		min-width: 0;
		overflow: hidden;
		border-radius: var(--radius-input);
		background: var(--color-code-surface);
		color: var(--color-code-ink);
	}

	.markdown-language {
		padding: var(--space-2xs) var(--space-sm);
		border-block-end: var(--rule-hair) solid var(--color-code-rule);
		color: var(--color-code-muted);
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
	}

	.markdown-code pre {
		max-width: 100%;
		padding: var(--space-xs) var(--space-sm);
		overflow-x: auto;
		white-space: pre;
	}

	.markdown-code code {
		font-family: var(--font-outlier);
		font-size: var(--text-sm);
	}

	.markdown-body a,
	.markdown-body .link-path {
		color: var(--color-accent-active);
		text-decoration: underline;
		text-decoration-thickness: var(--rule-hair);
		text-underline-offset: var(--space-3xs);
	}

	/* Markdown links that resolve to workspace files open the file browser. */
	.markdown-body .link-path {
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		font: inherit;
		text-align: start;
	}

	.markdown-image {
		display: block;
		width: auto;
		max-width: 100%;
		max-height: 18rem;
		border: var(--rule-hair) solid var(--color-rule);
		border-radius: var(--radius-card);
		object-fit: contain;
	}

	.markdown-table-wrap {
		max-width: 100%;
		overflow-x: auto;
	}

	.markdown-body table {
		width: 100%;
		border-collapse: collapse;
		font-variant-numeric: tabular-nums;
	}

	.markdown-body th,
	.markdown-body td {
		padding: var(--space-2xs) var(--space-xs);
		border-block-end: var(--rule-hair) solid var(--color-rule);
		text-align: start;
		vertical-align: top;
	}

	.markdown-body .align-center {
		text-align: center;
	}

	.markdown-body .align-right {
		text-align: end;
	}

	.markdown-body hr {
		width: 100%;
		margin: var(--space-2xs) 0;
		border: 0;
		border-block-start: var(--rule-hair) solid var(--color-rule-2);
	}

	.item.pending .body {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-3xs) var(--space-2xs);
		color: var(--color-muted);
	}

	.working-label {
		flex: none;
		font-weight: 600;
	}

	.activity-spinner {
		flex: none;
		width: 0.8em;
		height: 0.8em;
		align-self: center;
		border: 2px solid var(--color-rule-2);
		border-top-color: var(--color-accent-active);
		border-radius: 50%;
		animation: activity-spin 0.8s linear infinite;
	}

	.working-description {
		min-width: 0;
		max-width: 100%;
		overflow-wrap: anywhere;
		color: var(--color-neutral);
	}

	.media-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
	}

	.message-image {
		display: inline-flex;
		flex-direction: column;
		gap: var(--space-2xs);
		width: fit-content;
		max-width: 100%;
		color: var(--color-muted);
		font-family: var(--font-body);
		font-size: var(--text-xs);
		text-decoration: none;
	}

	.message-image img {
		display: block;
		width: auto;
		max-width: min(100%, 32.5rem);
		max-height: 18rem;
		border: var(--rule-hair) solid var(--color-rule);
		border-radius: var(--radius-card);
		background: var(--color-paper-2);
		object-fit: contain;
	}

	.message-image span {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.gutter {
		color: var(--color-muted);
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
		user-select: none;
	}

	.item.reason,
	.item.file,
	.item.web-search,
	.item.plan,
	.item.note,
	.item.review,
	.item.subagent,
	.item.collab,
	.item.generic {
		padding: var(--space-2xs) var(--space-sm);
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--color-neutral);
	}

	/* Gutter glyphs are a size down from their body text; share the first
	   baseline so the pair doesn't sit visibly askew. */
	.item.reason,
	.item.plan,
	.item.note,
	.item.review,
	.item.subagent,
	.item.generic,
	.item.err {
		align-items: baseline;
	}

	.item.reason .body {
		font-style: italic;
	}

	.item.reason .gutter,
	.item.plan .gutter {
		color: var(--color-warning);
	}

	.item.file .gutter,
	.item.web-search .gutter,
	.item.review .gutter,
	.item.subagent .gutter,
	.item.collab .gutter {
		color: var(--color-accent-active);
	}

	.item.file {
		display: block;
	}

	.web-search-icon {
		display: grid;
		place-items: center;
		width: var(--space-sm);
		height: var(--space-sm);
	}

	.web-search-icon svg {
		display: block;
		width: 100%;
		height: 100%;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.5;
	}

	.item.web-search .body {
		min-width: 0;
		color: var(--color-muted);
		font-size: var(--text-sm);
		white-space: normal;
	}

	.web-search-detail,
	.item.web-search a {
		color: var(--color-ink-2);
		overflow-wrap: anywhere;
	}

	.item.web-search a {
		text-decoration-thickness: var(--rule-hair);
		text-underline-offset: var(--space-3xs);
	}

	.web-search-count {
		white-space: nowrap;
	}

	.item.cmd {
		display: flex;
		flex-direction: column;
		gap: 0;
		overflow: visible;
		border-radius: 0;
		background: transparent;
		color: var(--color-neutral);
	}

	.cmd-line {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: var(--space-2xs);
		align-items: center;
		min-height: var(--control-height-compact);
		padding: var(--space-2xs) var(--space-sm);
	}

	.cmd-toggle {
		width: 100%;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: pointer;
	}

	.cmd-toggle:focus-visible {
		outline: 2px solid var(--color-focus);
		outline-offset: -2px;
	}

	.cmd-toggle:active {
		opacity: 0.72;
	}

	.item.cmd .gutter,
	.cmd-text,
	.cmd-result,
	.cmd-out {
		font-family: var(--font-outlier);
	}

	/* The $ prompt shares the command's type size so the centered pair can't
	   drift apart vertically. */
	.item.cmd .gutter {
		color: var(--color-warning);
		font-size: var(--text-sm);
	}

	.cmd-text {
		min-width: 0;
		color: var(--color-ink-2);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.cmd-status {
		color: var(--color-muted);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.cmd-status.completed {
		color: var(--color-success);
	}

	.cmd-status.failed {
		color: var(--color-error);
	}

	.cmd-result {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: var(--space-sm);
		height: var(--space-sm);
		color: var(--color-warning);
	}

	.cmd-result.completed {
		color: var(--color-success);
	}

	.cmd-result.failed {
		color: var(--color-error);
	}

	.cmd-result svg {
		display: block;
		width: 100%;
		height: 100%;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.75;
	}

	.cmd-meta {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2xs);
		min-height: var(--space-sm);
	}

	.cmd-output-count {
		color: var(--color-muted);
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.cmd-disclosure {
		flex: none;
		width: var(--space-sm);
		height: var(--space-sm);
		fill: none;
		stroke: var(--color-muted);
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.5;
		transition: transform var(--dur-micro) var(--ease-in-out);
	}

	.cmd-disclosure.expanded {
		transform: rotate(90deg);
	}

	.cmd-out {
		width: 100%;
		margin: 0;
		padding: var(--space-2xs) var(--space-sm) var(--space-xs) calc(var(--space-md) + var(--space-xs));
		border-block-start: var(--rule-hair) solid var(--color-rule);
		background: transparent;
		color: var(--color-muted);
		font-size: var(--text-sm);
		line-height: 1.45;
		max-height: 15rem;
		overflow: auto;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.fc {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) auto;
		gap: var(--space-2xs);
		align-items: baseline;
		font-family: var(--font-outlier);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.fc + .fc,
	.step + .step {
		margin-block-start: var(--space-2xs);
	}

	.fc .kind {
		color: var(--color-accent-active);
		font-size: var(--text-sm);
		font-weight: 500;
	}

	.fc-line-stats { display: inline-flex; gap: var(--space-2xs); color: var(--color-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
	.fc-line-stats span:first-child { color: var(--color-success); }
	.fc-line-stats span:last-child { color: var(--color-error); }

	.fc .path {
		min-width: 0;
	}

	.fc .path-link {
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
		font: inherit;
		text-align: start;
		text-decoration: underline;
		text-decoration-color: transparent;
		text-decoration-thickness: var(--rule-hair);
		text-underline-offset: var(--space-3xs);
		overflow-wrap: anywhere;
		transition: color var(--dur-micro) var(--ease-out);
	}

	.fc .path-link:hover,
	.fc .path-link:focus-visible {
		color: var(--color-accent-active);
		text-decoration-color: currentColor;
	}

	.step {
		color: var(--color-muted);
		font-family: var(--font-outlier);
		font-size: var(--text-sm);
	}

	.step.completed {
		color: var(--color-success);
	}

	.step.inProgress {
		color: var(--color-warning);
	}

	.item.note .body,
	.item.generic .body,
	.collab-detail {
		font-size: var(--text-sm);
	}

	/* Slash-command echoes and their output are TUI-style text whose column
	   alignment (/help, /status) depends on a fixed-pitch face. */
	.item.note .body,
	.item.generic .body {
		font-family: var(--font-outlier);
		line-height: 1.5;
	}

	.stopped-resume {
		margin-left: var(--space-sm);
		vertical-align: middle;
	}

	.item.note.err,
	.item.err {
		padding: var(--space-xs) var(--space-sm);
		border: var(--rule-hair) solid var(--color-error);
		border-radius: var(--radius-input);
		background: var(--color-error-soft);
		color: var(--color-error);
	}

	.retry-capacity {
		flex: none;
		margin-inline-start: auto;
		padding: var(--space-3xs) var(--space-xs);
		border: var(--rule-hair) solid currentColor;
		border-radius: var(--radius-input);
		background: transparent;
		color: inherit;
		cursor: pointer;
		font: inherit;
		font-size: var(--text-xs);
	}

	.retry-capacity:hover:not(:disabled),
	.retry-capacity:focus-visible {
		background: var(--color-error-soft);
		outline: var(--rule-fine) solid var(--color-focus);
		outline-offset: var(--focus-offset);
	}

	.retry-capacity:disabled {
		cursor: progress;
		opacity: 0.7;
	}

	.item.review {
		color: var(--color-ink);
	}

	.item.subagent .agent-path {
		color: var(--color-accent-active);
		font-family: var(--font-outlier);
	}

	.item.subagent .agent-activity-link {
		padding: 0;
		border: 0;
		background: transparent;
		font: inherit;
		text-align: start;
		cursor: pointer;
	}

	.item.subagent .agent-activity-link:hover {
		text-decoration: underline;
	}

	.item.subagent .agent-activity-link:focus-visible {
		outline: var(--rule-fine) solid var(--color-focus);
		outline-offset: var(--focus-offset);
	}

	.item.collab {
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
	}

	.collab-line {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: var(--space-xs);
		align-items: baseline;
	}

	.collab-text {
		min-width: 0;
		color: var(--color-ink-2);
		overflow-wrap: anywhere;
	}

	.collab-detail {
		margin-inline-start: calc(var(--space-md) + var(--space-xs));
		color: var(--color-muted);
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	/* No rule above the composer: the card is lifted by shadow, and a hairline
	   here would read as the border the card deliberately drops. The block
	   padding keeps that shadow clear of the viewport edge. */
	.composer-shell {
		padding: var(--space-xs) var(--space-2xs) calc(var(--space-xs) + env(safe-area-inset-bottom));
		background: var(--color-paper);
	}

	.composer-state {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.composer,
	.composer-anchor,
	.attachments {
		width: min(100%, var(--measure-reading));
		margin-inline: auto;
	}

	/* Zero-height anchor so the slash popup floats above the composer,
	   overlaying the transcript instead of pushing layout. */
	.composer-anchor {
		position: relative;
		height: 0;
	}

	.slash-popup {
		position: absolute;
		inset-inline: 0;
		inset-block-end: var(--space-xs);
		z-index: var(--z-dropdown);
		display: flex;
		flex-direction: column;
		max-height: min(16rem, 40dvh);
		padding: var(--space-3xs);
		overflow-y: auto;
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-input);
		background: var(--color-paper);
		box-shadow: var(--shadow-card);
	}

	.slash-option {
		display: grid;
		grid-template-columns: max-content max-content minmax(0, 1fr);
		gap: var(--space-2xs) var(--space-xs);
		align-items: baseline;
		width: 100%;
		min-height: var(--control-height-compact);
		padding: var(--space-2xs) var(--space-xs);
		border: 0;
		border-inline-start: var(--rule-fine) solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-neutral);
		cursor: pointer;
		font: inherit;
		text-align: start;
	}

	.slash-option.selected {
		border-inline-start-color: var(--color-accent);
		background: var(--color-paper-3);
		color: var(--color-ink);
	}

	.slash-name {
		color: var(--color-ink-2);
		font-family: var(--font-outlier);
		font-size: var(--text-sm);
		white-space: nowrap;
	}

	.slash-option.selected .slash-name {
		color: var(--color-ink);
	}

	.slash-args {
		color: var(--color-muted);
		font-family: var(--font-outlier);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.slash-desc {
		grid-column: 3;
		justify-self: end;
		max-width: 100%;
		overflow: hidden;
		color: var(--color-muted);
		font-size: var(--text-xs);
		text-align: end;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Two rows: the message spans the card's width, the action row sits under it. */
	.composer {
		display: grid;
		grid-template-areas:
			'message'
			'actions';
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3xs);
		align-items: start;
		padding: var(--space-2xs);
		border: 0;
		border-radius: var(--radius-xl);
		background: var(--color-paper);
		/* No hairline: the card is separated from the canvas by light alone. */
		box-shadow: var(--shadow-float);
		transition: box-shadow var(--dur-short) var(--ease-out);
	}

	.composer:focus-within {
		box-shadow: var(--shadow-float-raised);
	}

	.image-input {
		display: none;
	}

	.composer-actions {
		grid-area: actions;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2xs);
	}

	.composer-actions-end {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		gap: var(--space-2xs);
	}

	.attach {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--control-height);
		min-width: var(--control-height);
		padding-inline: 0;
		border-color: transparent;
		background: transparent;
		color: var(--color-neutral);
		font-size: var(--text-sm);
	}

	.switch-prompt-model {
		flex: 0 1 auto;
		max-width: 12rem;
		min-height: var(--control-height-compact);
		padding: 0.25rem 0.5rem;
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-input);
		background: var(--color-accent-soft);
		color: var(--color-neutral);
		font-size: var(--text-xs);
		line-height: 1.2;
		white-space: normal;
	}

	.switch-prompt-model:hover:not(:disabled) {
		background: var(--color-accent);
		color: var(--color-accent-ink);
	}

	/* Model and thinking pickers use native selects over compact visible labels. */
	.model-picker,
	.effort {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: var(--space-3xs);
		min-width: 0;
		min-height: var(--control-height);
		padding-inline: var(--space-2xs);
		border-radius: var(--radius-input);
		color: var(--color-muted);
		transition: background-color var(--dur-micro) var(--ease-out);
	}

	.model-picker {
		max-width: min(21rem, 58vw);
	}

	.model-picker:focus-within,
	.effort:focus-within {
		outline: var(--rule-fine) solid var(--color-focus);
		outline-offset: var(--focus-offset);
	}

	.composer-select {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		appearance: none;
		border: 0;
		background: transparent;
		color: transparent;
		cursor: pointer;
		opacity: 0;
	}

	.composer-select:disabled {
		cursor: progress;
	}

	.model-picker-copy { display: flex; flex: 1 1 auto; flex-direction: column; justify-content: center; min-width: 0; gap: 0.05rem; line-height: 1.15; }
	.model-picker-label,
	.effort-label {
		font-size: var(--text-base);
	}

	.model-picker-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.composer-select-chevron {
		flex: none;
		width: var(--space-xs);
		height: var(--space-xs);
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 2;
	}

	textarea {
		grid-area: message;
		min-height: var(--control-height);
		max-height: min(15rem, 42dvh);
		padding: var(--space-2xs) var(--space-2xs) 0;
		border-color: transparent;
		background: transparent;
		font-family: var(--font-body);
		font-size: var(--text-base);
		line-height: 1.4;
		overflow-y: hidden;
		resize: none;
	}

	textarea:focus-visible {
		border-color: transparent;
		outline-color: transparent;
	}

	.send {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--control-height);
		min-width: var(--control-height);
		padding-inline: 0;
		border-radius: var(--radius-pill);
		background: var(--color-accent);
		color: var(--color-accent-ink);
		font-size: var(--text-sm);
	}

	.send:disabled {
		border-color: var(--color-rule);
		background: var(--color-paper-3);
		color: var(--color-muted);
		opacity: 1;
	}

	.control-icon {
		flex: none;
		width: var(--space-sm);
		height: var(--space-sm);
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 2;
	}

	.send:focus-visible,
	.welcome-action:focus-visible,
	.new:focus-visible,
	.settings-open:focus-visible,
	.mini:not(.ghost):focus-visible {
		outline-color: var(--color-ink);
	}

	.attachments {
		display: flex;
		flex-wrap: nowrap;
		gap: var(--space-2xs);
		padding-block-end: var(--space-2xs);
		overflow-x: auto;
		scrollbar-width: none;
	}

	.attachments::-webkit-scrollbar {
		display: none;
	}

	.attachment {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		max-width: 100%;
		min-height: var(--control-height);
		padding-inline: var(--space-sm);
		border: var(--rule-hair) solid var(--color-rule);
		border-radius: var(--radius-input);
		background: var(--color-paper-3);
		color: var(--color-neutral);
		cursor: pointer;
		font-size: var(--text-sm);
		white-space: nowrap;
	}

	.attachment > span:not(.attachment-file-icon) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.attachment .attachment-file-icon {
		display: grid;
		flex: 0 0 auto;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border: var(--rule-hair) solid var(--color-rule);
		border-radius: var(--radius-input);
		background: var(--color-paper-2);
		color: var(--color-muted);
		font-family: var(--font-outlier);
		font-size: 0.55rem;
		font-weight: 700;
		letter-spacing: 0.04em;
	}

	.attachment .attachment-preview {
		flex: 0 0 auto;
		width: 2.25rem;
		height: 2.25rem;
		border: var(--rule-hair) solid var(--color-rule);
		border-radius: var(--radius-input);
		background: var(--color-paper-2);
		object-fit: cover;
	}

	.attachment svg {
		flex: none;
		width: var(--space-sm);
		height: var(--space-sm);
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-width: 1.75;
	}

	.archive-toast {
		position: fixed;
		inset-inline: var(--space-sm);
		inset-block-end: calc(var(--space-sm) + env(safe-area-inset-bottom));
		z-index: var(--z-toast);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		max-width: 26rem;
		min-height: var(--control-height);
		margin-inline: auto;
		padding: var(--space-2xs) var(--space-sm);
		border: var(--rule-hair) solid var(--color-rule-2);
		border-radius: var(--radius-input);
		background: var(--color-ink-2);
		box-shadow: var(--shadow-card);
		color: var(--color-paper);
		font-size: var(--text-sm);
	}

	.archive-toast.error {
		border-color: var(--color-error);
		background: var(--color-error-soft);
		color: var(--color-error);
	}

	.archive-toast button {
		min-height: var(--control-height-compact);
		padding-inline: var(--space-xs);
		border: var(--rule-hair) solid currentColor;
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
		cursor: pointer;
		font-size: var(--text-xs);
		font-weight: 600;
		transition:
			background-color var(--dur-micro) var(--ease-out),
			transform var(--dur-micro) var(--ease-out);
	}

	@media (hover: hover) and (pointer: fine) {
		.cmd-toggle:hover .cmd-text {
			color: var(--color-ink);
		}

		.raw-toggle {
			opacity: 0;
			pointer-events: none;
		}

		.item.agent:hover .raw-toggle,
		.item.agent:focus-within .raw-toggle,
		.raw-toggle[aria-pressed='true'] {
			opacity: 1;
			pointer-events: auto;
		}

		.cwd-input:hover,
		.profile-input:hover {
			background: var(--color-paper-2);
		}

		.mini.ghost:hover,
		.attach:hover,
		.model-picker:hover,
		.effort:hover,
		.stop:hover,
		.raw-toggle:hover,
		.copy-agent:hover,
		.files-trigger:hover,
		.session-info-trigger:hover,
		.session-info-close:hover,
		.rename-session:hover,
		.theme-toggle:hover,
		.new-activity:hover,
		.archive-toast button:hover {
			background: var(--color-paper-3);
		}

		.sidebar-toggle:hover,
		.drawer-close:hover {
			background: transparent;
			color: var(--color-accent-active);
		}

		.new:hover,
		.settings-open:hover,
		.mini:not(.ghost):hover,
		.send:hover,
		.welcome-action:hover {
			background: var(--color-accent-active);
		}

		.session:hover {
			background: var(--color-paper-3);
			color: var(--color-ink);
		}

		.message-image:hover {
			color: var(--color-accent-active);
		}
	}

	.sidebar-toggle:active,
	.drawer-close:active,
	.new:active,
	.settings-open:active,
	.mini:active,
	.stop:active,
	.files-trigger:active,
	.session-info-trigger:active,
	.session-info-close:active,
	.theme-toggle:active,
	.attach:active,
	.send:active,
	.welcome-action:active,
	.sidebar-scrim:active,
	.session:active,
	.attachment:active {
		transform: translateY(1px);
	}

	/* .new-activity is normally lifted above the composer; :active keeps the
	   lift and adds the shared 1px press. */
	.new-activity:active {
		transform: translateY(calc(-100% - var(--space-2xs) + 1px));
	}

	.archive-toast button:active {
		transform: translateY(1px);
	}

	.message-image:active {
		opacity: 0.72;
	}

	@media (min-width: 40rem) {
		.welcome {
			padding-inline: var(--space-xl);
		}

		.goal-tracker {
			flex-direction: row;
			align-items: center;
			justify-content: space-between;
		}

		.goal-metrics {
			flex: 0 0 auto;
		}

		.transcript {
			padding-inline: var(--space-lg);
		}

		.composer-shell {
			padding-inline: var(--space-lg);
		}

		.attachments {
			flex-wrap: wrap;
			overflow-x: visible;
		}

		.composer {
			padding: var(--space-xs);
		}

	}

	@media (min-width: 60rem) {
		.app {
			grid-template-columns: var(--rail-width) minmax(0, 1fr);
		}

		.app.rail-hidden {
			grid-template-columns: minmax(0, 1fr);
		}

		.sidebar-scrim,
		.app:not(.rail-hidden) .welcome-menu,
		.app:not(.rail-hidden) .header-menu {
			display: none;
		}

		.app.rail-hidden .sidebar {
			display: none;
		}

		.sidebar,
		.sidebar.open {
			position: relative;
			inset: auto;
			z-index: var(--z-base);
			width: auto;
			padding-block-start: 0;
			box-shadow: none;
			transform: none;
			transition: none;
		}

		.brand {
			padding-inline: var(--space-sm);
		}

		.topbar {
			grid-template-columns: minmax(16rem, 1fr) auto auto;
			gap: var(--space-2xs) var(--space-xs);
			padding: calc(var(--space-xs) + env(safe-area-inset-top)) var(--space-xs) var(--space-xs);
		}

		.app.rail-hidden .topbar {
			grid-template-columns: auto minmax(16rem, 1fr) auto auto;
		}

		.session-meta,
		.session-facts {
			display: flex;
		}

		.session-facts {
			grid-column: auto;
			justify-self: end;
		}

		.session-state {
			flex: none;
		}

		.welcome {
			grid-template-columns: minmax(0, 1.18fr) minmax(0, 0.82fr);
			align-items: end;
			gap: var(--space-2xl);
			padding-block: var(--space-2xl);
		}

		.welcome h1 {
			font-size: var(--text-display);
		}

		.message-image img {
			max-width: 32.5rem;
		}
	}

	@media (min-width: 90rem) {
		.welcome {
			gap: var(--space-3xl);
		}

		.transcript {
			padding-block-start: var(--space-sm);
		}
	}

	@media (min-width: 60rem) and (hover: hover) and (pointer: fine) {
		.new,
		.settings-open,
		.mini,
		.stop,
		.files-trigger,
		.session-info-trigger,
		.session-info-close,
		.rename-session,
		.theme-toggle,
		.attach,
		.send,
		.attachment,
		.cwd-input,
		.profile-input,
		.model-picker,
		.effort,
		textarea {
			min-height: var(--control-height-compact);
		}

		.attach,
		.send,
		.new,
		.settings-open,
		.stop,
		.files-trigger,
		.session-info-trigger,
		.theme-toggle,
		.session-info-close {
			width: var(--control-height-compact);
			min-width: var(--control-height-compact);
			height: var(--control-height-compact);
		}

		.session {
			min-height: var(--control-height-compact);
		}
	}

	@media (hover: none), (pointer: coarse) {
		.raw-toggle {
			opacity: 0;
			pointer-events: none;
		}

		.item.agent.tapped .raw-toggle,
		.item.agent:focus-within .raw-toggle,
		.raw-toggle[aria-pressed='true'] {
			opacity: 1;
			pointer-events: auto;
		}
	}

	@media (pointer: coarse) {
		.cmd-toggle {
			min-height: var(--control-height);
		}

		.sidebar-toggle,
		.drawer-close,
		.new,
		.settings-open,
		.mini,
		.stop,
		.files-trigger,
		.session-info-trigger,
		.session-info-close,
		.theme-toggle,
		.attach,
		.model-picker,
		.effort,
		.send,
		.welcome-action,
		.attachment,
		.new-activity,
		.archive-toast button,
		.copy-agent,
		.slash-option,
		.raw-toggle,
		.session {
			min-height: var(--control-height);
		}

		.raw-toggle {
			width: var(--control-height);
		}
	}

	@media (max-width: 36rem) {
		.original-prompt {
			flex-wrap: wrap;
		}

		.original-prompt p {
			flex: 1 1 50%;
		}

		.session-bar-right {
			flex: 1 0 100%;
			flex-wrap: wrap;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		*,
		*::before,
		*::after {
			animation-duration: var(--dur-micro) !important;
			animation-iteration-count: 1 !important;
			transition-duration: var(--dur-micro) !important;
		}

		.run-dot.running,
		.session-state-dot.running,
		.activity-spinner {
			animation: none;
		}
	}

	@keyframes activity-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes pulse-status {
		50% {
			opacity: 0.38;
		}
	}
</style>

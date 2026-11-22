import { useParams } from "react-router-dom";
import useUser from "@/hooks/useUser";
import Shell, { SECTIONS, useLayout } from "./Shell";
import useNyteDesk from "./useNyteDesk";
import ApprovalInspector from "./ApprovalInspector";
import {
  AgentBridgeSection,
  ApprovalsSection,
  DashboardSection,
  EnginesSection,
  KnowledgeSection,
  LogsSection,
  MemoriesSection,
  TasksSection,
  WorkspaceSection,
} from "./sections";
import { Card, muted } from "./ui";

const TITLES = {
  ...Object.fromEntries(SECTIONS.map((s) => [s.id, s.label])),
  dashboard: "Main dashboard",
};

const VIEWS = {
  dashboard: DashboardSection,
  workspace: WorkspaceSection,
  engines: EnginesSection,
  agentbridge: AgentBridgeSection,
  tasks: TasksSection,
  approvals: ApprovalsSection,
  knowledge: KnowledgeSection,
  memories: MemoriesSection,
  logs: LogsSection,
};

/**
 * NyteDesk dashboard (approved Gemini concept): /nytedesk, /nytedesk/:section,
 * /nytedesk/approvals/:taskId and /nytedesk/tasks/:taskId. All data comes from
 * the authenticated NyteDesk API; the server enforces every permission.
 */
export default function NyteDeskApp() {
  const { section = "dashboard", taskId } = useParams();
  const { user } = useUser();
  const data = useNyteDesk(user?.role);
  const [layout, updateLayout] = useLayout();
  const active = VIEWS[section] ? section : "dashboard";
  const View = VIEWS[active];
  const title = taskId
    ? section === "tasks"
      ? "Task"
      : "Approval inspector"
    : TITLES[active];

  let content;
  if (data.loading) {
    content = <p className={`pt-6 text-sm ${muted}`}>Loading NyteDesk…</p>;
  } else if (!data.ready) {
    content = <NotReady status={data.status} error={data.error} />;
  } else if (taskId) {
    content = (
      <ApprovalInspector
        taskId={taskId}
        user={user}
        onChanged={data.refresh}
        backTo={section === "tasks" ? "tasks" : "approvals"}
      />
    );
  } else {
    content = (
      <View
        data={{ ...data, role: user?.role }}
        role={user?.role}
        layout={layout}
        updateLayout={updateLayout}
      />
    );
  }

  return (
    <Shell
      active={active}
      title={title}
      approvalsCount={data.approvals.length}
      engines={data.engines}
      user={user}
      layout={layout}
      updateLayout={updateLayout}
      workspaces={data.workspaces}
      sync={data.ready ? data.sync : null}
      now={data.now}
      onRefresh={data.refresh}
    >
      {data.error && data.ready && (
        <p
          role="alert"
          className="mt-3 text-xs text-red-300"
        >{`Some data could not be loaded: ${data.error}`}</p>
      )}
      {content}
    </Shell>
  );
}

function NotReady({ status, error }) {
  let message = error || "NyteDesk is not available.";
  if (status && !status.enabled)
    message = "NyteDesk is disabled. Set NYTEDESK_ENABLED=true on the server.";
  else if (status && !status.multiUser)
    message = "NyteDesk requires AnythingLLM multi-user mode.";
  return (
    <div className="pt-6 max-w-xl">
      <Card title="NyteDesk unavailable" labelledBy="nd-unavailable">
        <p className="text-sm" role="status">
          {message}
        </p>
      </Card>
    </div>
  );
}

/**
 * Remote-development agent tools: the model's hands on the connected Linux
 * server (ssh_list / ssh_exec / ssh_ls / ssh_read / ssh_write / ssh_workspace).
 * Registered globally by the host half; cloud-workspace sessions additionally
 * get same-name shadow tools (session-tools) routed by the session cwd.
 *
 * The tools consume the shared SshRuntime (ctx.ssh, host plane): one engine
 * serves the tools and the legacy preset-scoped adapters (fs-ssh /
 * subprocess-ssh), so a connection established by one is visible to the others.
 */
import type { JobRegistry } from '@deepseek-ai/dsh-jobs';
import type { SshRuntime } from './ssh-service';
/** The host-list tool. */
export declare function sshListTool(runtime: SshRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Run a shell command on the remote server (foreground or background job). */
export declare function sshExecTool(runtime: SshRuntime, jobs: JobRegistry | undefined): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Open, list or close a local port forward through the SSH connection. */
export declare function sshTunnelTool(runtime: SshRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** List a remote directory. */
export declare function sshLsTool(runtime: SshRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Read a remote file (text, capped at 2 MiB). */
export declare function sshReadTool(runtime: SshRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Write a remote file (text over SFTP). */
export declare function sshWriteTool(runtime: SshRuntime): import("@deepseek-ai/dsh-tools").ToolDefinition;
/**
 * Create or list placeholder workspaces (a remote dir mapped to a local dir).
 *
 * `register` is injected by index.ts so the create path registers with the DSH
 * workspace registry exactly like the settings-card typert endpoint does — a
 * workspace bound through this tool must also show up in "select workspace".
 * It is optional: headless runs have no registry, and the placeholder directory
 * is usable regardless.
 */
export declare function sshWorkspaceTool(runtime: SshRuntime, register?: (localPath: string, title: string) => void): import("@deepseek-ai/dsh-tools").ToolDefinition;

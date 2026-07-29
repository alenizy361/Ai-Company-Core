// The complete tool registry. A tool that is not here does not exist.
import type { Tool } from './types.ts';
import { readFileTool, writeFileTool, listDirTool, searchTool } from './impl/files.ts';
import { runCommandTool } from './impl/command.ts';
import { readArtifactTool, writeArtifactTool } from './impl/artifacts.ts';
import { memorySearchTool, memoryWriteTool, taskNoteTool } from './impl/memory.ts';

const ALL: Tool[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  searchTool,
  runCommandTool,
  readArtifactTool,
  writeArtifactTool,
  memorySearchTool,
  memoryWriteTool,
  taskNoteTool,
];

export const TOOL_REGISTRY: Map<string, Tool> = new Map(ALL.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOL_REGISTRY.get(name);
}

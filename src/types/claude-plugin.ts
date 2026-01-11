// Source URL parsing result
export interface ParsedSource {
  owner: string;
  repo: string;
  branch?: string; // undefined = default branch
  path?: string; // path within repo to plugin root
}

// Plugin manifest (.claude-plugin/plugin.json)
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
}

// Component types that can be installed
export type ComponentType = 'skills' | 'commands' | 'hooks';

// Discovered components from filesystem
export interface DiscoveredComponents {
  skills: string[];
  commands: string[];
  hooks: string[];
}

// Installation options
export interface PluginInstallOptions {
  skills?: boolean;
  commands?: boolean;
  hooks?: boolean;
  force?: boolean;
  targetDir?: string;
}

// Single installed component record
export interface InstalledComponent {
  name: string;
  type: ComponentType;
  path: string;
}

// Plugin entry in agentio.json
export interface AgentioPluginEntry {
  source: string;
  version: string;
  components?: ComponentType[];
  installedComponents: InstalledComponent[];
}

// agentio.json structure
export interface AgentioJson {
  plugins: {
    [pluginName: string]: AgentioPluginEntry;
  };
}

// Installation result
export interface InstallResult {
  success: boolean;
  manifest: PluginManifest;
  installed: InstalledComponent[];
}

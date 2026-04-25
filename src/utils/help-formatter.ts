import type { Command } from 'commander';

export type CommandGroups = Record<string, string[]>;

/**
 * Override the program's `formatHelp` so that subcommands are grouped under
 * named section headers. Any command not listed in `groups` falls into "Other".
 * Hidden commands are skipped automatically by `helper.visibleCommands(cmd)`.
 */
export function applyGroupedHelp(program: Command, groups: CommandGroups): void {
  program.configureHelp({
    formatHelp: (cmd, helper) => {
      const termWidth = helper.padWidth(cmd, helper);

      let output = '';
      output += `Usage: ${helper.commandUsage(cmd)}\n\n`;
      const desc = helper.commandDescription(cmd);
      if (desc) output += `${desc}\n\n`;

      const optionList = helper.visibleOptions(cmd);
      if (optionList.length > 0) {
        output += 'Options:\n';
        for (const opt of optionList) {
          output += `  ${helper.optionTerm(opt).padEnd(termWidth)}  ${helper.optionDescription(opt)}\n`;
        }
        output += '\n';
      }

      const allCommands = helper.visibleCommands(cmd);
      const groupedNames = new Set<string>();
      for (const list of Object.values(groups)) for (const n of list) groupedNames.add(n);

      const renderGroup = (label: string, names: string[]) => {
        const cmds = names
          .map((n) => allCommands.find((c) => c.name() === n))
          .filter((c): c is Command => !!c);
        if (cmds.length === 0) return;
        output += `${label}:\n`;
        for (const c of cmds) {
          const term = helper.subcommandTerm(c).padEnd(termWidth);
          output += `  ${term}  ${helper.subcommandDescription(c)}\n`;
        }
        output += '\n';
      };

      for (const [label, names] of Object.entries(groups)) {
        renderGroup(label, names);
      }

      const other = allCommands.filter((c) => !groupedNames.has(c.name()));
      if (other.length > 0) {
        output += 'Other:\n';
        for (const c of other) {
          const term = helper.subcommandTerm(c).padEnd(termWidth);
          output += `  ${term}  ${helper.subcommandDescription(c)}\n`;
        }
        output += '\n';
      }

      return output.trimEnd() + '\n';
    },
  });
}

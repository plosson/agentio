import { Command } from 'commander';
import { createInterface } from 'readline';
import { CliError, handleError } from '../utils/errors';
import * as fs from 'fs';
import * as path from 'path';

const GITHUB_REPO = 'plosson/agentio';
const SKILLS_PATH = 'claude/skills';

interface GitHubContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url: string | null;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function fetchGitHubContents(repoPath: string): Promise<GitHubContent[]> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${repoPath}`;
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'agentio-skill-manager',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new CliError('NOT_FOUND', `Path not found: ${repoPath}`);
    }
    throw new CliError('API_ERROR', `GitHub API error: ${response.statusText}`);
  }

  return response.json();
}

async function fetchFileContent(downloadUrl: string): Promise<string> {
  const response = await fetch(downloadUrl, {
    headers: {
      'User-Agent': 'agentio-skill-manager',
    },
  });

  if (!response.ok) {
    throw new CliError('API_ERROR', `Failed to download file: ${response.statusText}`);
  }

  return response.text();
}

async function listAvailableSkills(): Promise<string[]> {
  const contents = await fetchGitHubContents(SKILLS_PATH);
  return contents
    .filter((item) => item.type === 'dir')
    .map((item) => item.name);
}

async function downloadSkillFolder(
  skillName: string,
  targetDir: string
): Promise<void> {
  const skillPath = `${SKILLS_PATH}/${skillName}`;
  const contents = await fetchGitHubContents(skillPath);

  // Create target directory
  fs.mkdirSync(targetDir, { recursive: true });

  for (const item of contents) {
    const targetPath = path.join(targetDir, item.name);

    if (item.type === 'file' && item.download_url) {
      const content = await fetchFileContent(item.download_url);
      fs.writeFileSync(targetPath, content);
    } else if (item.type === 'dir') {
      // Recursively download subdirectories
      await downloadSkillFolder(`${skillName}/${item.name}`, targetPath);
    }
  }
}

async function installSkill(
  skillName: string,
  baseDir: string,
  skipPrompt: boolean
): Promise<boolean> {
  const targetDir = path.join(baseDir, '.claude', 'skills', skillName);

  // Check if skill already exists
  if (fs.existsSync(targetDir)) {
    if (!skipPrompt) {
      const answer = await prompt(
        `Skill '${skillName}' already exists at ${targetDir}. Update? [y/N] `
      );
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        console.error(`Skipping '${skillName}'`);
        return false;
      }
    }
    // Remove existing skill directory before updating
    fs.rmSync(targetDir, { recursive: true });
  }

  console.error(`Installing skill: ${skillName}...`);
  await downloadSkillFolder(skillName, targetDir);
  console.log(`Installed: ${skillName} -> ${targetDir}`);
  return true;
}

export function registerSkillCommands(program: Command): void {
  const skill = program
    .command('skill')
    .description('Manage Claude Code skills');

  skill
    .command('list')
    .description('List available skills from the repository')
    .action(async () => {
      try {
        console.error('Fetching available skills...');
        const skills = await listAvailableSkills();

        if (skills.length === 0) {
          console.log('No skills found in repository');
          return;
        }

        console.log('Available skills:');
        for (const name of skills) {
          console.log(`  ${name}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  skill
    .command('install')
    .description('Install skills from the repository')
    .argument('[skill-name]', 'Name of the skill to install (omit to install all)')
    .option('-d, --dir <path>', 'Target directory (default: current directory)')
    .option('-y, --yes', 'Skip confirmation prompts')
    .action(async (skillName, options) => {
      try {
        const baseDir = options.dir ? path.resolve(options.dir) : process.cwd();

        // Verify base directory exists
        if (!fs.existsSync(baseDir)) {
          throw new CliError(
            'INVALID_PARAMS',
            `Directory does not exist: ${baseDir}`
          );
        }

        console.error(`Target: ${path.join(baseDir, '.claude', 'skills')}`);

        if (skillName) {
          // Install specific skill
          const skills = await listAvailableSkills();
          if (!skills.includes(skillName)) {
            throw new CliError(
              'NOT_FOUND',
              `Skill '${skillName}' not found`,
              `Available skills: ${skills.join(', ')}`
            );
          }
          await installSkill(skillName, baseDir, options.yes);
        } else {
          // Install all skills
          console.error('Fetching available skills...');
          const skills = await listAvailableSkills();

          if (skills.length === 0) {
            console.log('No skills found in repository');
            return;
          }

          console.error(`Found ${skills.length} skill(s)`);

          let installed = 0;
          for (const name of skills) {
            const success = await installSkill(name, baseDir, options.yes);
            if (success) installed++;
          }

          console.log(`\nInstalled ${installed} of ${skills.length} skill(s)`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}

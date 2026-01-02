#!/usr/bin/env bun
import { Command } from 'commander';

const program = new Command();

program
  .name('allcli')
  .description('Unified communication CLI')
  .version('0.1.0');

program.parse();

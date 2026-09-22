#!/usr/bin/env node
import { Command } from 'commander';

import { SvgGenError, generate } from './generate.js';

interface GenerateCliOptions {
  out: string;
  default?: string;
  hover?: string;
  clicked?: string;
  full?: string;
}

const program = new Command();

program
  .name('svg-gen')
  .description('Turn a source SVG icon into the icon.svg + colors.json config a button needs.');

program
  .command('generate')
  .description('Normalize a single-color icon into icon.svg + colors.json.')
  .argument('<input>', 'input SVG file')
  .option('--out <dir>', 'output directory', './appreciator-out')
  .option('--default <color>', 'CSS color for the default state')
  .option('--hover <color>', 'CSS color for the hover state')
  .option('--clicked <color>', 'CSS color for the clicked state')
  .option('--full <color>', 'CSS color for the full (max-clicks-reached) state')
  .action(async (input: string, options: GenerateCliOptions) => {
    try {
      const result = await generate({
        inputPath: input,
        outDir: options.out,
        colors: {
          default: options.default,
          hover: options.hover,
          clicked: options.clicked,
          full: options.full,
        },
      });
      console.log(`Wrote normalized icon and colors to ${options.out}:`);
      console.log(`  icon:   ${result.iconPath}`);
      console.log(`  colors: ${result.colorsPath}`);
      console.log(`Colors: ${JSON.stringify(result.colors)}`);
    } catch (error) {
      if (error instanceof SvgGenError) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

await program.parseAsync(process.argv);

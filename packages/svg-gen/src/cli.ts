#!/usr/bin/env node
import { Command } from 'commander';

import { generateExplicit } from './explicit.js';
import { SvgGenError, generate } from './generate.js';

interface GenerateCliOptions {
  out: string;
  explicit?: boolean;
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
  .description(
    'Normalize a single-color icon into icon.svg + colors.json (default), or, with --explicit, ' +
      'validate and copy 4 hand-authored per-state SVGs instead.',
  )
  .argument(
    '<inputs...>',
    '1 input SVG file, or with --explicit exactly 4: <default.svg> <hover.svg> <clicked.svg> <full.svg>',
  )
  .option('--out <dir>', 'output directory', './appreciator-out')
  .option('--explicit', 'skip normalization; copy 4 explicit per-state SVGs instead')
  .option('--default <color>', 'CSS color for the default state')
  .option('--hover <color>', 'CSS color for the hover state')
  .option('--clicked <color>', 'CSS color for the clicked state')
  .option('--full <color>', 'CSS color for the full (max-clicks-reached) state')
  .action(async (inputs: string[], options: GenerateCliOptions) => {
    try {
      if (options.explicit) {
        if (inputs.length !== 4) {
          program.error(
            `--explicit requires exactly 4 input files, got ${inputs.length}: ` +
              '<default.svg> <hover.svg> <clicked.svg> <full.svg>',
          );
        }
        const [defaultSvg, hover, clicked, full] = inputs as [string, string, string, string];
        const result = await generateExplicit({
          inputs: { default: defaultSvg, hover, clicked, full },
          outDir: options.out,
        });
        console.log(`Wrote explicit per-state SVGs to ${options.out}:`);
        for (const [state, path] of Object.entries(result.files)) {
          console.log(`  ${state}: ${path}`);
        }
        console.log(`  manifest: ${result.manifestPath}`);
      } else {
        if (inputs.length !== 1) {
          program.error(
            `generate expects exactly 1 input file, got ${inputs.length} (use --explicit for 4)`,
          );
        }
        const result = await generate({
          inputPath: inputs[0] as string,
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
      }
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

// MCP prompts: reusable message templates that load the tool routine into
// an agent's context at the start of a task.

import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

import type { SystemData, SystemRegistry } from './types.ts';

function consumptionLine(data: SystemData): string {
  const pkg = data.cfg.componentsPkg ?? data.id;
  return data.cfg.componentModel === 'custom-elements'
    ? `This system is custom elements: import '${pkg}' once to register the tags, then write them as HTML tags (e.g. <the-tag-name>). Do not import each component by name.`
    : `This system is React: import each component by name from '${pkg}'. Do not guess a different package.`;
}

function buildMessage(task: string, registry: SystemRegistry, systemId: string | undefined): string {
  let data: SystemData | undefined;
  let systemLine: string;
  try {
    data = registry.get(systemId);
    systemLine = `Design system: **${data.cfg.name ?? data.id}** (id: \`${data.id}\`).`;
  } catch {
    const ids = registry.ids();
    systemLine =
      ids.length > 0
        ? `Multiple design systems are configured (${ids.join(', ')}). Pass a \`system\` argument to every tool call below to pick one.`
        : 'No design system is configured yet.';
  }

  const consumption = data ? consumptionLine(data) : "Check which system you're using, then read its consumption model (import line, or registered custom-element tags) before writing markup.";

  return `You are about to build UI for this task:\n\n> ${task}\n\n${systemLine}\n\nFollow this routine. It exists because agents repeatedly invent component and prop names that this system never had, use another system's vocabulary, hardcode raw colors and spacing, and ship controls without an accessible name. Every one of those is a lookup you can make instead of a guess.\n\n1. **Search before you write.** Call \`search_components\` with what you need in plain words (a concept, or a name you think it might have). Don't start typing an import from memory.\n2. **Resolve every component name before importing it.** Call \`resolve_component\` on the exact name you're about to write. If it comes back \`alias\`, this system calls it something else -- use the real name it returns. If it comes back \`missing\`, do not invent it; use one of the nearest real components it lists, or ask.\n3. **Read \`get_component\` before writing any props.** It has the real prop names, their exact allowed values (many are closed unions, not free strings), which are required, which are deprecated, and \`commonMistakes\` -- prop names agents commonly get wrong on that exact component.\n4. **Use \`find_token\` for every color and spacing value.** Never write a hex code, an \`rgb()\`, or a bare pixel/rem number. Give it the raw value or a word like 'muted' or 'gap' and write back exactly what it returns.\n5. **Give every interactive control an accessible name.** \`get_component\`'s \`a11y\` field says whether one is \`required\`, \`recommended\`, or \`none\`. Icon-only controls almost always need one.\n6. **Never invent.** A tool that returns \`missing\` or an empty result is the correct answer, not a reason to guess. If nothing fits, say so and ask, instead of writing something that looks plausible.\n\n${consumption}`;
}

export function registerPrompts(server: McpServer, registry: SystemRegistry): void {
  server.registerPrompt(
    'build-ui',
    {
      title: 'Build UI with the design system',
      description: "Start a UI task with this system's real component names, prop values, tokens and the tool routine loaded, so you search and verify instead of guessing.",
      argsSchema: {
        task: z.string().describe('What you are about to build, in plain words.'),
        system: z.string().optional().describe('System id to use. Optional when only one system is configured.'),
      },
    },
    async (args): Promise<GetPromptResult> => {
      return {
        description: 'Routine for building UI against a grounded design system.',
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: buildMessage(args.task, registry, args.system) },
          },
        ],
      };
    },
  );
}

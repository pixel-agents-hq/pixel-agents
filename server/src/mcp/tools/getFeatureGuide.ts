import { z } from 'zod';

import { FEATURE_GUIDE, featureGuideIndex } from '../../tutorial/featureGuide.js';
import { defineTool, ok, refuse } from '../tool.js';

export const getFeatureGuide = defineTool({
  name: 'get_feature_guide',
  title: 'Pixel Agents feature guide',
  description:
    'What Pixel Agents does for its user, feature by feature, accurate to this version: the office and its ' +
    'characters, agent cards and statuses, speech bubbles and sounds, terminals (standalone desktop and phone), ' +
    'launching (Directories, the roster, Worktrees), recent conversations and resume, the Characters view, the ' +
    'layout editor, usage bars, the office radio, sub-agents and teammates, Settings, this MCP and the tutorial. ' +
    "Without `topic`, every topic; with one, that topic alone. Use it to answer the user's questions about the " +
    'office instead of guessing.',
  input: {
    topic: z
      .string()
      .min(1)
      .optional()
      .describe(
        `A topic id: ${featureGuideIndex()
          .map((t) => t.id)
          .join(', ')}.`,
      ),
  },
  changes: false,
  uses: [],
  run: (args) => {
    if (args.topic === undefined) return ok({ topics: FEATURE_GUIDE });
    const topic = FEATURE_GUIDE.find((t) => t.id === args.topic?.trim().toLowerCase());
    if (!topic) {
      return refuse(
        `There is no topic ${args.topic}: the topics are ${featureGuideIndex()
          .map((t) => t.id)
          .join(', ')}.`,
      );
    }
    return ok(topic);
  },
});

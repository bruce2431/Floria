/**
 * Neuron 内置工具桶 — feature('NEURON_RAG') 门控注册入口
 *
 * recall（读，仅次于六大基础工具）+ remember（写）+ ops 三件
 * （neuron_list / neuron_source / neuron_fill_precog，shouldDefer）。
 */

import { RecallTool } from './recall.js'
import { RememberTool } from './remember.js'
import {
  NeuronListTool,
  NeuronSourceTool,
  NeuronFillPrecogTool,
  NeuronCogTool,
} from './ops.js'

export const neturonTools = [
  RecallTool,
  RememberTool,
  NeuronListTool,
  NeuronSourceTool,
  NeuronFillPrecogTool,
  NeuronCogTool,
] as const

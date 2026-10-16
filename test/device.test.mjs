/**
 * 执行设备解析的回归测试（coding-plan §5.1.0）。
 *
 * ⚠️ **无卡路径是回归重点**：它就是本机修复驱动之前真实存在的环境
 * （`cuInit` 返回 100、`get_cuda_device_count()` 为 0），也是发布到别的机器后
 * 最常见的形态。有卡路径同样要覆盖，因为本机现在就是有卡的。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadPure } from './helpers.mjs'

const { resolveDevice, pickComputeType } = await loadPure('device')

const CUDA_TYPES = ['float32', 'int8', 'int8_float32'] // 本机 P40 实测集合
const CPU_TYPES = ['float32', 'int16', 'int8', 'int8_float32'] // 本机实测集合

test('有卡：auto 解析为 cuda，并落在 int8_float32', () => {
  const result = resolveDevice('auto', {
    cudaDeviceCount: 1,
    supportedComputeTypes: { cuda: CUDA_TYPES, cpu: CPU_TYPES },
  })
  assert.equal(result.device, 'cuda')
  assert.equal(result.deviceSource, 'auto')
  assert.equal(result.computeType, 'int8_float32')
  assert.equal(result.reason, 'cuda-available')
})

test('无卡：auto 静默落 CPU + int8，且不抛错', () => {
  const result = resolveDevice('auto', {
    cudaDeviceCount: 0,
    supportedComputeTypes: { cpu: CPU_TYPES },
  })
  assert.equal(result.device, 'cpu')
  assert.equal(result.deviceSource, 'auto')
  assert.equal(result.computeType, 'int8')
  assert.equal(result.reason, 'no-cuda-device')
})

test('无卡：CUDA 计数抛错也照样落 CPU（reason 区分于"没有设备"）', () => {
  const result = resolveDevice('auto', {
    cudaCountError: 'RuntimeError: CUDA failed with error no CUDA-capable device is detected',
    supportedComputeTypes: { cpu: CPU_TYPES },
  })
  assert.equal(result.device, 'cpu')
  assert.equal(result.computeType, 'int8')
  assert.equal(result.reason, 'cuda-count-failed')
})

test('探测整体失败（例如 ctranslate2 都 import 不了）也不抛错', () => {
  const result = resolveDevice('auto', { probeError: 'ModuleNotFoundError: ctranslate2' })
  assert.equal(result.device, 'cpu')
  assert.equal(result.reason, 'cuda-probe-failed')
})

test('有卡但 CUDA 一个可用档都没有 → 落 CPU 并标注 unsupported-compute-type', () => {
  const result = resolveDevice('auto', {
    cudaDeviceCount: 1,
    supportedComputeTypes: { cuda: [], cpu: CPU_TYPES },
  })
  assert.equal(result.device, 'cpu')
  assert.equal(result.reason, 'unsupported-compute-type')
})

test('显式 cuda 尊重配置，并由调用方负责可用性校验', () => {
  const result = resolveDevice('cuda', {
    cudaDeviceCount: 0,
    supportedComputeTypes: { cpu: CPU_TYPES },
  })
  assert.equal(result.device, 'cuda')
  assert.equal(result.deviceSource, 'config')
})

test('显式 cpu 用 cpu 的可用档', () => {
  const result = resolveDevice('cpu', {
    cudaDeviceCount: 1,
    supportedComputeTypes: { cuda: CUDA_TYPES, cpu: CPU_TYPES },
  })
  assert.equal(result.device, 'cpu')
  assert.equal(result.deviceSource, 'config')
  assert.equal(result.computeType, 'int8')
})

test('float16 绝不被首选（P40 上会被 CTranslate2 直接拒绝）', () => {
  // 即使探测集合里出现 float16，也不会被选中——偏好表里没有它
  const cuda = pickComputeType('cuda', ['float16', 'int8_float32'])
  assert.equal(cuda, 'int8_float32')
  const cpu = pickComputeType('cpu', ['float16', 'int8'])
  assert.equal(cpu, 'int8')
})

test('探测集合里没有偏好档时取一个稳定值，而不是崩掉', () => {
  assert.equal(pickComputeType('cpu', ['int16']), 'int16')
  assert.equal(pickComputeType('cuda', ['bfloat16']), 'bfloat16')
})

test('完全没有探测结果时给默认档', () => {
  assert.equal(pickComputeType('cpu', undefined), 'int8')
  assert.equal(pickComputeType('cuda', undefined), 'int8_float32')
})

/**
 * 执行设备解析：有卡用卡，无卡自动降级（coding-plan §5.1.0）。
 *
 * 这个文件**故意不 import 任何 `@deepseek-ai/*`**：它是纯逻辑，靠注入的探测结果工作，
 * 于是两份用例——"有卡"与"无卡"——都能在仓库侧直接跑断言（`scripts/selftest-device.mjs`），
 * 不需要宿主运行时。无卡那条路径是回归重点：它就是本机修复驱动之前真实存在的环境。
 */

/** 设备取值：`auto` 交给解析器决定，`cuda`/`cpu` 是显式指定。 */
export type DeviceRequest = 'auto' | 'cuda' | 'cpu'

/** 实际生效的设备。 */
export type ResolvedDevice = 'cuda' | 'cpu'

/** 降级 / 解析原因，供 `media_probe` 如实回报。 */
export type DeviceReason =
  | 'configured'
  | 'cuda-available'
  | 'no-cuda-device'
  | 'cuda-count-failed'
  | 'cuda-probe-failed'
  | 'unsupported-compute-type'

/**
 * 注入的探测结果——把"问 CUDA"这件事与"怎么决策"分开。
 * 真实实现由 `src/media/whisper.ts` 用 `ctranslate2` 填这个结构。
 */
export interface DeviceProbe {
  /** `get_cuda_device_count()` 的值；抛错时为 undefined。 */
  readonly cudaDeviceCount?: number
  /** `get_cuda_device_count()` 是否抛错（例如 CUDA 运行库缺失）。 */
  readonly cudaCountError?: string
  /** `get_supported_compute_types(device)` 的结果，按 device 分组。 */
  readonly supportedComputeTypes?: Readonly<Record<string, readonly string[]>>
  /** 探测过程本身的异常（例如 `import ctranslate2` 失败）。 */
  readonly probeError?: string
}

export interface DeviceResolution {
  readonly device: ResolvedDevice
  /** `config` = 用户显式指定；`auto` = 解析器决定。 */
  readonly deviceSource: 'config' | 'auto'
  readonly computeType: string
  /** 正常用卡时为 null；降级时说明原因。 */
  readonly reason: DeviceReason | null
}

/**
 * 计算档位偏好：GPU 优先 `int8_float32`，CPU 优先 `int8`。
 *
 * ⚠️ **`float16` 绝不作为首选**：本机 P40（GP102）实测会被 CTranslate2 直接拒绝
 * （`ValueError: ... do not support efficient float16 computation`），CPU 上更不行。
 * 这里的偏好表只写"安全且实测可用"的档位，真正取值仍以探测结果为准。
 */
const PREFERRED: Readonly<Record<ResolvedDevice, readonly string[]>> = {
  cuda: ['int8_float32', 'int8', 'float32'],
  cpu: ['int8', 'int8_float32', 'float32'],
}

/** 在探测到的可用集合里挑一个偏好档；都不在时回退到默认档。 */
export function pickComputeType(
  device: ResolvedDevice,
  supported: readonly string[] | undefined,
): string {
  const preferences = PREFERRED[device]
  if (supported && supported.length > 0) {
    for (const candidate of preferences) {
      if (supported.includes(candidate)) return candidate
    }
    // 探测集里没有偏好档（例如只有 int16）：取第一个稳定值，并把选择交给调用方记录。
    return [...supported].sort()[0]!
  }
  return preferences[0]!
}

/**
 * 解析设备与计算档。
 *
 * 规则（顺序即优先级）：
 * 1. `config` 显式给了 `cuda`/`cpu` → 尊重用户，`deviceSource: 'config'`；
 * 2. `auto` → 探测：有可用 CUDA 设备就用 `cuda`，否则静默 `cpu`；
 * 3. **任何探测失败都不抛错**，只把原因写进 `reason`。
 */
export function resolveDevice(
  requested: DeviceRequest,
  probe: DeviceProbe = {},
): DeviceResolution {
  const supported = probe.supportedComputeTypes

  if (requested === 'cpu') {
    return {
      device: 'cpu',
      deviceSource: 'config',
      computeType: pickComputeType('cpu', supported?.['cpu']),
      reason: null,
    }
  }

  if (requested === 'cuda') {
    return {
      device: 'cuda',
      deviceSource: 'config',
      computeType: pickComputeType('cuda', supported?.['cuda']),
      // 显式指定时的可用性由调用方（execute 前置校验）去验证并抛出，这里不静默改设备。
      reason: null,
    }
  }

  // requested === 'auto'
  if (probe.probeError) {
    return {
      device: 'cpu',
      deviceSource: 'auto',
      computeType: pickComputeType('cpu', supported?.['cpu']),
      reason: 'cuda-probe-failed',
    }
  }
  if (probe.cudaCountError) {
    return {
      device: 'cpu',
      deviceSource: 'auto',
      computeType: pickComputeType('cpu', supported?.['cpu']),
      reason: 'cuda-count-failed',
    }
  }
  if ((probe.cudaDeviceCount ?? 0) < 1) {
    return {
      device: 'cpu',
      deviceSource: 'auto',
      computeType: pickComputeType('cpu', supported?.['cpu']),
      reason: 'no-cuda-device',
    }
  }

  const cudaTypes = supported?.['cuda']
  if (cudaTypes && cudaTypes.length === 0) {
    return {
      device: 'cpu',
      deviceSource: 'auto',
      computeType: pickComputeType('cpu', supported?.['cpu']),
      reason: 'unsupported-compute-type',
    }
  }

  return {
    device: 'cuda',
    deviceSource: 'auto',
    computeType: pickComputeType('cuda', cudaTypes),
    reason: 'cuda-available',
  }
}

/**
 * D3D8 adapter-format validation — thin wrappers over the shared, version-parameterised
 * DX format-support core (see backends/webgpu/shared/dx-format-support.ts). Kept as named
 * D3D8 helpers so the rest of the d3d8 module imports read naturally; all logic lives in
 * the shared module so D3D9 stays in lock-step.
 */

import {
    checkDxDeviceFormat,
    checkDxDeviceMultiSampleType,
    checkDxDeviceType,
    checkDxDepthStencilMatch,
    isDxDepthStencilFormat,
    isDxExclusiveFormat,
    isDxRenderTargetFormat,
} from '../../backends/webgpu/shared/dx-format-support';

export { D3D_OK, D3DERR_INVALIDCALL, D3DERR_NOTAVAILABLE } from '../../backends/webgpu/shared/dx-format-support';

export function isD3D8ExclusiveFormat(format: number): boolean {
    return isDxExclusiveFormat(format, 8);
}

export function isD3D8RenderTargetFormat(format: number): boolean {
    return isDxRenderTargetFormat(format, 8);
}

export function isD3D8DepthStencilFormat(format: number): boolean {
    return isDxDepthStencilFormat(format, 8);
}

export function checkD3D8DeviceType(
    adapter: number,
    devType: number,
    adapterFormat: number,
    backBufferFormat: number,
    windowed: number,
): number {
    return checkDxDeviceType(8, adapter, devType, adapterFormat, backBufferFormat, windowed);
}

export function checkD3D8DeviceFormat(
    adapter: number,
    deviceType: number,
    adapterFormat: number,
    usage: number,
    rType: number,
    checkFormat: number,
): number {
    return checkDxDeviceFormat(8, adapter, deviceType, adapterFormat, usage, rType, checkFormat);
}

export function checkD3D8DepthStencilMatch(
    adapter: number,
    deviceType: number,
    adapterFormat: number,
    renderTargetFormat: number,
    depthStencilFormat: number,
): number {
    return checkDxDepthStencilMatch(8, adapter, deviceType, adapterFormat, renderTargetFormat, depthStencilFormat);
}

export function checkD3D8DeviceMultiSampleType(
    adapter: number,
    deviceType: number,
    surfaceFormat: number,
    windowed: number,
    multiSampleType: number,
): number {
    return checkDxDeviceMultiSampleType(8, adapter, deviceType, surfaceFormat, windowed, multiSampleType);
}

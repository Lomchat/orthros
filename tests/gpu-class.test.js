import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the GPU\'s short name shown beside the frame rate', async () => {
  const { gpuShortName } = await import('../src/web/gpu-class.js');
  assert.equal(gpuShortName('ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'RTX 4060 Laptop GPU');
  assert.equal(gpuShortName('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x0000A7A0) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'Iris Xe Graphics');
  assert.equal(gpuShortName('ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'Radeon RX 6700 XT');
  assert.equal(gpuShortName('ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'), 'Apple M1');
  assert.equal(gpuShortName('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'), 'SwiftShader');
  assert.equal(gpuShortName(null), null);
});

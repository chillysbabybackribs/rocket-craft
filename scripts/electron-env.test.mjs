import { test } from 'node:test'
import assert from 'node:assert/strict'
import { electronEnv } from './electron-env.mjs'

test('drops Rocket and parent Electron variables but keeps Craft Studio settings', () => {
  const env = electronEnv({ PATH: '/bin', ROCKET_DATA_DIR: '/home/u/.config/Rocket', ROCKET_SELF_CHECK: '1', ELECTRON_RUN_AS_NODE: '1', CRAFT_USER_DATA: '/tmp/p', CRAFT_NO_SANDBOX: '1' })
  assert.deepEqual(env, { PATH: '/bin', CRAFT_USER_DATA: '/tmp/p', CRAFT_NO_SANDBOX: '1', ELECTRON_DISABLE_SANDBOX: '1' })
})

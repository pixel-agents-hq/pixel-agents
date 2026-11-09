import { runSaga } from 'redux-saga'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchHealth } from './serverSaga'
import { healthFailed, healthSucceeded } from './serverSlice'
import type { HealthInfo } from './serverSlice'

async function runFetchHealth() {
  const dispatched: unknown[] = []
  await runSaga({ dispatch: (action: unknown) => dispatched.push(action) }, fetchHealth).toPromise()
  return dispatched
}

describe('fetchHealth', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dispatches healthSucceeded with the server answer', async () => {
    const health: HealthInfo = { status: 'ok', uptime: 3, pid: 42 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(health))))

    expect(await runFetchHealth()).toEqual([healthSucceeded(health)])
  })

  it('dispatches healthFailed on a non-2xx answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))

    expect(await runFetchHealth()).toEqual([healthFailed('HTTP 503')])
  })

  it('dispatches healthFailed when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))

    expect(await runFetchHealth()).toEqual([healthFailed('connection refused')])
  })
})

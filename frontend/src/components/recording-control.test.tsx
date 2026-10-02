import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordingControl } from './recording-control'

function actions() {
  return {
    enabled: true, recording: false, handsFree: false, pending: false, canStop: false,
    press: vi.fn(async () => true),
    release: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    startHandsFree: vi.fn(async () => true),
  }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

function down(button: HTMLElement, pointerId = 1) {
  fireEvent.pointerDown(button, { button: 0, pointerId, pointerType: 'touch' })
}
function up(target: HTMLElement, pointerId = 1) {
  fireEvent.pointerUp(target, { pointerId, pointerType: 'touch' })
}

describe('recording gestures', () => {
  it('captures a pointer and handles release outside without an extra stop', () => {
    const props = actions()
    render(<RecordingControl {...props} />)
    const button = screen.getByRole('button', { name: 'Hold to record' })
    down(button)
    expect(button.setPointerCapture).toHaveBeenCalledWith(1)
    up(document.body)
    fireEvent.lostPointerCapture(button, { pointerId: 1 })
    expect(props.press).toHaveBeenCalledTimes(1)
    expect(props.release).toHaveBeenCalledTimes(1)
    expect(props.stop).not.toHaveBeenCalled()
  })

  it('still handles outside release if pointer capture is unavailable', () => {
    const props = actions()
    render(<RecordingControl {...props} />)
    const button = screen.getByRole('button', { name: 'Hold to record' })
    vi.mocked(button.setPointerCapture).mockImplementationOnce(() => { throw new Error('capture unavailable') })
    down(button)
    up(document.body)
    expect(props.release).toHaveBeenCalledTimes(1)
  })

  it.each(['pointerCancel', 'lostPointerCapture'] as const)('stops once on %s and ignores the later release', (event) => {
    const props = actions()
    render(<RecordingControl {...props} />)
    const button = screen.getByRole('button', { name: 'Hold to record' })
    down(button)
    fireEvent[event](button, { pointerId: 1 })
    up(button)
    expect(props.stop).toHaveBeenCalledTimes(1)
    expect(props.release).not.toHaveBeenCalled()
  })

  it('stops a held recording on window focus loss', () => {
    const props = actions()
    render(<RecordingControl {...props} />)
    const button = screen.getByRole('button', { name: 'Hold to record' })
    down(button)
    fireEvent.blur(window)
    up(button)
    expect(props.stop).toHaveBeenCalledTimes(1)
    expect(props.release).not.toHaveBeenCalled()
  })

  it('stops a held recording when the page becomes hidden', () => {
    const props = actions()
    render(<RecordingControl {...props} />)
    down(screen.getByRole('button', { name: 'Hold to record' }))
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    expect(props.stop).toHaveBeenCalledTimes(1)
  })

  it('does not stop hands-free recording merely because the window loses focus', () => {
    const props = { ...actions(), recording: true, handsFree: true, canStop: true }
    render(<RecordingControl {...props} />)
    fireEvent.blur(window)
    expect(props.stop).not.toHaveBeenCalled()
    down(screen.getByRole('button', { name: 'Stop recording' }))
    expect(props.stop).toHaveBeenCalledTimes(1)
    expect(props.press).not.toHaveBeenCalled()
  })

  it('sends two matching press/release pairs for touch double-taps', () => {
    const props = actions()
    render(<RecordingControl {...props} />)
    const button = screen.getByRole('button', { name: 'Hold to record' })
    down(button)
    up(button)
    down(button)
    up(button)
    expect(props.press).toHaveBeenCalledTimes(2)
    expect(props.release).toHaveBeenCalledTimes(2)
    expect(props.stop).not.toHaveBeenCalled()
  })

  it('ignores a second pointer releasing during the first pointer hold', () => {
    const props = actions()
    render(<RecordingControl {...props} />)
    const button = screen.getByRole('button', { name: 'Hold to record' })
    down(button, 1)
    down(button, 2)
    up(document.body, 2)
    expect(props.press).toHaveBeenCalledTimes(1)
    expect(props.release).not.toHaveBeenCalled()
    up(document.body, 1)
    expect(props.release).toHaveBeenCalledTimes(1)
  })

  it('clears the hold on disconnect and accepts a fresh press after reconnect', () => {
    const props = actions()
    const { rerender } = render(<RecordingControl {...props} />)
    const button = screen.getByRole('button', { name: 'Hold to record' })
    down(button)
    rerender(<RecordingControl {...props} enabled={false} />)
    up(button)
    expect(props.release).not.toHaveBeenCalled()
    rerender(<RecordingControl {...props} />)
    down(button)
    up(button)
    expect(props.press).toHaveBeenCalledTimes(2)
    expect(props.release).toHaveBeenCalledTimes(1)
  })
})

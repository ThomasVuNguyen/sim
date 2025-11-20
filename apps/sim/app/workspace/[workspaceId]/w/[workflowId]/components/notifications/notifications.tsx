import { memo, useCallback, useState } from 'react'
import { X } from 'lucide-react'
import { useParams } from 'next/navigation'
import { Button } from '@/components/emcn'
import { createLogger } from '@/lib/logs/console/logger'
import {
  type NotificationAction,
  openCopilotWithMessage,
  useNotificationStore,
} from '@/stores/notifications'

const logger = createLogger('Notifications')
const MAX_VISIBLE_NOTIFICATIONS = 4
const SWIPE_DISMISS_THRESHOLD = 100
const SWIPE_VELOCITY_THRESHOLD = 0.5

/**
 * Individual notification item with swipe-to-dismiss functionality
 */
const NotificationItem = memo(function NotificationItem({
  notification,
  depth,
  onDismiss,
  onAction,
}: {
  notification: {
    id: string
    level: 'info' | 'error'
    message: string
    action?: NotificationAction
  }
  depth: number
  onDismiss: (id: string) => void
  onAction?: (id: string, action: NotificationAction) => void
}) {
  const [dragState, setDragState] = useState<{
    isDragging: boolean
    startX: number
    currentX: number
    startTime: number
  } | null>(null)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.target as HTMLElement
    if (
      target.closest('button') ||
      target.closest('a') ||
      target.closest('input') ||
      target.closest('[role="button"]')
    ) {
      return
    }

    setDragState({
      isDragging: false,
      startX: e.clientX,
      currentX: e.clientX,
      startTime: Date.now(),
    })
  }, [])

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragState) return

      const deltaX = e.clientX - dragState.startX

      if (!dragState.isDragging && Math.abs(deltaX) > 5) {
        setDragState({
          ...dragState,
          isDragging: true,
          currentX: e.clientX,
        })
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        return
      }

      if (dragState.isDragging) {
        setDragState({
          ...dragState,
          currentX: e.clientX,
        })
      }
    },
    [dragState]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragState) return

      if (dragState.isDragging) {
        const deltaX = dragState.currentX - dragState.startX
        const deltaTime = Date.now() - dragState.startTime
        const velocity = Math.abs(deltaX) / Math.max(deltaTime, 1)

        if (deltaX > SWIPE_DISMISS_THRESHOLD || velocity > SWIPE_VELOCITY_THRESHOLD) {
          logger.info('Notification dismissed via swipe', { id: notification.id })
          onDismiss(notification.id)
        }

        try {
          ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        } catch {}
      }

      setDragState(null)
    },
    [dragState, notification.id, onDismiss]
  )

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    setDragState(null)
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {}
  }, [])

  const dragOffset = dragState?.isDragging ? Math.max(0, dragState.currentX - dragState.startX) : 0
  const opacity = dragState?.isDragging
    ? Math.max(0.6, 1 - (dragOffset / SWIPE_DISMISS_THRESHOLD) * 0.4)
    : 1
  const xOffset = depth * 3

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={{
        transform: `translateX(${xOffset + dragOffset}px)`,
        opacity,
        transition: dragState?.isDragging ? 'none' : 'all 200ms ease-out',
      }}
      className='relative w-[240px] cursor-grab touch-pan-y select-none rounded-[4px] border bg-[#232323] active:cursor-grabbing'
    >
      <div className='flex flex-col gap-[6px] px-[8px] pt-[6px] pb-[8px]'>
        <div className='line-clamp-6 font-medium text-[12px] leading-[16px]'>
          <Button
            variant='ghost'
            onClick={() => onDismiss(notification.id)}
            aria-label='Dismiss notification'
            className='!p-1.5 -m-1.5 float-right ml-[16px]'
          >
            <X className='h-3 w-3' />
          </Button>
          {notification.level === 'error' && (
            <span className='mr-[6px] mb-[2.75px] inline-block h-[6px] w-[6px] rounded-[2px] bg-[var(--text-error)] align-middle' />
          )}
          {notification.message}
        </div>
        {notification.action && onAction && (
          <Button
            variant='active'
            onClick={() => onAction(notification.id, notification.action!)}
            className='px-[8px] py-[4px] font-medium text-[12px]'
          >
            {notification.action.type === 'copilot'
              ? 'Fix in Copilot'
              : notification.action.type === 'refresh'
                ? 'Refresh'
                : 'Take action'}
          </Button>
        )}
      </div>
    </div>
  )
})

/**
 * Notifications display component
 * Positioned in the bottom-right workspace area, aligned with terminal and panel spacing
 * Shows both global notifications and workflow-specific notifications
 */
export const Notifications = memo(function Notifications() {
  const params = useParams()
  const workflowId = params.workflowId as string

  const notifications = useNotificationStore((state) =>
    state.notifications.filter((n) => !n.workflowId || n.workflowId === workflowId)
  )
  const removeNotification = useNotificationStore((state) => state.removeNotification)
  const visibleNotifications = notifications.slice(0, MAX_VISIBLE_NOTIFICATIONS)

  /**
   * Executes a notification action and handles side effects.
   *
   * @param notificationId - The ID of the notification whose action is executed.
   * @param action - The action configuration to execute.
   */
  const executeAction = useCallback(
    (notificationId: string, action: NotificationAction) => {
      try {
        logger.info('Executing notification action', {
          notificationId,
          actionType: action.type,
          messageLength: action.message.length,
        })

        switch (action.type) {
          case 'copilot':
            openCopilotWithMessage(action.message)
            break
          case 'refresh':
            window.location.reload()
            break
          default:
            logger.warn('Unknown action type', { notificationId, actionType: action.type })
        }

        // Dismiss the notification after the action is triggered
        removeNotification(notificationId)
      } catch (error) {
        logger.error('Failed to execute notification action', {
          notificationId,
          actionType: action.type,
          error,
        })
      }
    },
    [removeNotification]
  )

  if (visibleNotifications.length === 0) {
    return null
  }

  return (
    <div className='fixed right-[calc(var(--panel-width)+16px)] bottom-[calc(var(--terminal-height)+16px)] z-[5] flex flex-col items-end'>
      {[...visibleNotifications].reverse().map((notification, index, stacked) => {
        const depth = stacked.length - index - 1

        return (
          <div key={notification.id} className={index > 0 ? '-mt-[78px]' : ''}>
            <NotificationItem
              notification={notification}
              depth={depth}
              onDismiss={removeNotification}
              onAction={executeAction}
            />
          </div>
        )
      })}
    </div>
  )
})

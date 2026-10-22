export interface StreamingNotificationRequest {
  workshopId: string;
  voiceChannelUrl?: string;
}

export interface StreamingNotificationService {
  notifyWorkshopStarting(request: StreamingNotificationRequest): Promise<void>;
}

export class UnconfiguredStreamingNotificationService implements StreamingNotificationService {
  public async notifyWorkshopStarting(_request: StreamingNotificationRequest): Promise<void> {
    throw new Error('Streaming notification service has not been configured');
  }
}

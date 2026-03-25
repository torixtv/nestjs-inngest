import { Injectable, Logger } from '@nestjs/common';
import { InngestFunction, InngestTracingService } from '@torixtv/nestjs-inngest';
import { OrderData } from './order.service';

export interface OrderFulfillmentEvent {
  name: 'order.fulfillment.ready';
  data: OrderData & { 
    transactionId: string;
    reservationId: string;
  };
}

@Injectable()
export class FulfillmentService {
  private readonly logger = new Logger(FulfillmentService.name);

  constructor(
    private readonly tracingService: InngestTracingService
  ) {}

  @InngestFunction({
    id: 'fulfill-order',
    triggers: { event: 'order.fulfillment.ready' }
  })
  async fulfillOrder(event: OrderFulfillmentEvent, step: any) {
    const { orderId, customerId, shippingAddress, items, reservationId } = event.data;
    
    this.logger.log(
      `Fulfilling order ${orderId} for customer ${customerId} - automatically traced`
    );

    // Generate shipping label
    const shippingLabel = await step.run('generate-shipping-label', () => {
      return this.generateShippingLabel(orderId, shippingAddress, items);
    });

    // Update order status
    await step.run('update-order-status', () => {
      return this.updateOrderStatus(orderId, 'shipped', {
        trackingNumber: shippingLabel.trackingNumber,
        carrier: shippingLabel.carrier,
        estimatedDelivery: shippingLabel.estimatedDelivery
      });
    });

    // Send confirmation notification
    await step.sendEvent('send-order-confirmation', {
      name: 'order.confirmation.send',
      data: {
        orderId,
        customerId,
        trackingNumber: shippingLabel.trackingNumber,
        carrier: shippingLabel.carrier,
        estimatedDelivery: shippingLabel.estimatedDelivery,
        items: items.map(item => ({
          productId: item.productId,
          quantity: item.quantity,
          price: item.price
        }))
      }
    });

    this.logger.log(
      `Order ${orderId} fulfilled successfully. Tracking: ${shippingLabel.trackingNumber}`
    );

    return {
      success: true,
      status: 'shipped',
      trackingNumber: shippingLabel.trackingNumber,
      carrier: shippingLabel.carrier,
      estimatedDelivery: shippingLabel.estimatedDelivery
    };
  }

  private async generateShippingLabel(
    orderId: string,
    shippingAddress: any,
    items: Array<{ productId: string; quantity: number; price: number }>
  ): Promise<{
    trackingNumber: string;
    carrier: string;
    shippingCost: number;
    estimatedDelivery: string;
  }> {
    // Simulate shipping API call
    await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 200));

    // Calculate shipping cost based on weight and destination
    const weight = this.calculateWeight(items);
    const shippingCost = this.calculateShippingCost(weight, shippingAddress.country);
    
    // Select carrier based on destination and cost
    const carrier = shippingAddress.country === 'US' ? 'FedEx' : 'DHL';
    
    // Generate tracking number
    const trackingNumber = `${carrier.toUpperCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
    
    // Calculate estimated delivery
    const deliveryDays = shippingAddress.country === 'US' ? 2 : 5;
    const estimatedDelivery = new Date(Date.now() + deliveryDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    return {
      trackingNumber,
      carrier,
      shippingCost,
      estimatedDelivery
    };
  }

  private async updateOrderStatus(
    orderId: string,
    status: string,
    metadata: Record<string, any>
  ): Promise<void> {
    // Simulate database update
    await new Promise(resolve => setTimeout(resolve, 30 + Math.random() * 40));
    
    this.logger.log(`Order ${orderId} status updated to: ${status}`, metadata);
  }

  private calculateWeight(items: Array<{ productId: string; quantity: number }>): number {
    // Simulate weight calculation based on product catalog
    const productWeights = {
      'prod_456': 1.2, // kg
      'prod_789': 0.8,
      'prod_123': 2.1,
    };

    return items.reduce((totalWeight, item) => {
      const weight = productWeights[item.productId as keyof typeof productWeights] || 1.0;
      return totalWeight + (weight * item.quantity);
    }, 0);
  }

  private calculateShippingCost(weight: number, country: string): number {
    const baseRate = country === 'US' ? 8.99 : 24.99;
    const weightRate = country === 'US' ? 2.50 : 5.00;
    
    return baseRate + (weight * weightRate);
  }
}

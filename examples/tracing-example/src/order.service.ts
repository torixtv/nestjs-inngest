import { Injectable, Logger } from '@nestjs/common';
import { InngestFunction, InngestTracingService } from '@torixtv/nestjs-inngest';

export interface OrderData {
  orderId: string;
  customerId: string;
  items: Array<{
    productId: string;
    quantity: number;
    price: number;
  }>;
  paymentMethod: string;
  shippingAddress: {
    street: string;
    city: string;
    country: string;
  };
  totalAmount: number;
}

export interface OrderReceivedEvent {
  name: 'order.received';
  data: OrderData;
}

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  @InngestFunction({
    id: 'order-received',
    triggers: { event: 'order.received' }
  })
  async handleOrderReceived(event: OrderReceivedEvent, step: any) {
    const { orderId, customerId, totalAmount } = event.data;
    
    this.logger.log(
      `Processing order ${orderId} for customer ${customerId} - automatically traced`
    );

    // Validate order
    const isValid = await step.run('validate-order', () => {
      return this.validateOrder(event.data);
    });

    if (!isValid) {
      await step.sendEvent('send-order-validation-failed', {
        name: 'order.validation.failed',
        data: { orderId, reason: 'Invalid order data' }
      });
      return { success: false, reason: 'Validation failed' };
    }

    // Initiate payment processing
    await step.sendEvent('send-order-payment-required', {
      name: 'order.payment.required',
      data: event.data
    });

    this.logger.log(`Order ${orderId} validated and payment initiated`);
    return { success: true, orderId, status: 'payment_pending' };
  }

  private async validateOrder(orderData: OrderData): Promise<boolean> {
    // Simulate order validation logic
    const isValidCustomer = orderData.customerId && orderData.customerId.startsWith('cust_');
    const hasItems = orderData.items && orderData.items.length > 0;
    const hasValidAmount = orderData.totalAmount > 0;
    const hasShippingAddress = orderData.shippingAddress && 
      orderData.shippingAddress.street && 
      orderData.shippingAddress.city;

    // Simulate async validation (database lookup, etc.)
    await new Promise(resolve => setTimeout(resolve, 10));

    return isValidCustomer && hasItems && hasValidAmount && hasShippingAddress;
  }
}

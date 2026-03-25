import { Injectable, Logger } from '@nestjs/common';
import { InngestFunction, InngestTracingService } from '@torixtv/nestjs-inngest';

export interface OrderConfirmationEvent {
  name: 'order.confirmation.send';
  data: {
    orderId: string;
    customerId: string;
    trackingNumber: string;
    carrier: string;
    estimatedDelivery: string;
    items: Array<{
      productId: string;
      quantity: number;
      price: number;
    }>;
  };
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  // Simulate customer database
  private customers = new Map([
    ['cust_123', { email: 'john.doe@example.com', name: 'John Doe', preferences: { sms: true, email: true } }],
    ['cust_456', { email: 'jane.smith@example.com', name: 'Jane Smith', preferences: { sms: false, email: true } }],
    ['cust_789', { email: 'bob.johnson@example.com', name: 'Bob Johnson', preferences: { sms: true, email: true } }],
  ]);

  constructor(
    private readonly tracingService: InngestTracingService
  ) {}

  @InngestFunction({
    id: 'send-order-confirmation',
    triggers: { event: 'order.confirmation.send' }
  })
  async sendOrderConfirmation(event: OrderConfirmationEvent, step: any) {
    const { orderId, customerId, trackingNumber, carrier, estimatedDelivery, items } = event.data;
    
    this.logger.log(
      `Sending order confirmation for ${orderId} to customer ${customerId} - automatically traced`
    );

    // Get customer details
    const customer = await step.run('get-customer-details', () => {
      return this.getCustomerDetails(customerId);
    });

    if (!customer) {
      this.logger.error(`Customer ${customerId} not found`);
      return { success: false, error: 'Customer not found' };
    }

    // Render email template
    const emailContent = await step.run('render-email-template', () => {
      return this.renderConfirmationEmail({
        orderId,
        customer,
        trackingNumber,
        carrier,
        estimatedDelivery,
        items
      });
    });

    // Send email notification
    const emailResult = await step.run('send-confirmation-email', () => {
      return this.sendEmail(customer.email, emailContent);
    });

    // Send SMS notification if enabled
    let smsResult = null;
    if (customer.preferences.sms) {
      smsResult = await step.run('send-confirmation-sms', () => {
        return this.sendSMS(customerId, {
          orderId,
          trackingNumber,
          carrier
        });
      });
    }

    const success = emailResult.success && (smsResult === null || smsResult.success);

    this.logger.log(
      `Order confirmation sent for ${orderId}. Email: ${emailResult.success ? 'sent' : 'failed'}, SMS: ${smsResult ? (smsResult.success ? 'sent' : 'failed') : 'skipped'}`
    );

    return {
      success,
      notifications: {
        email: emailResult,
        sms: smsResult
      }
    };
  }

  private async getCustomerDetails(customerId: string) {
    // Simulate database query
    await new Promise(resolve => setTimeout(resolve, 10));
    return this.customers.get(customerId) || null;
  }

  private async renderConfirmationEmail(data: {
    orderId: string;
    customer: any;
    trackingNumber: string;
    carrier: string;
    estimatedDelivery: string;
    items: Array<{ productId: string; quantity: number; price: number }>;
  }): Promise<{ subject: string; body: string; html: string }> {
    // Simulate template rendering
    await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 50));

    const totalAmount = data.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    const subject = `Order Confirmation - ${data.orderId}`;
    
    const body = `
Dear ${data.customer.name},

Your order ${data.orderId} has been shipped!

Order Details:
${data.items.map(item => `- Product ${item.productId}: ${item.quantity} x $${item.price}`).join('\n')}

Total: $${totalAmount.toFixed(2)}

Shipping Information:
Carrier: ${data.carrier}
Tracking Number: ${data.trackingNumber}
Estimated Delivery: ${data.estimatedDelivery}

Thank you for your business!
    `;

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Order Confirmation - ${data.orderId}</h2>
        <p>Dear ${data.customer.name},</p>
        <p>Your order has been shipped!</p>
        
        <div style="background: #f5f5f5; padding: 15px; margin: 20px 0;">
          <h3>Order Details</h3>
          ${data.items.map(item => 
            `<p>Product ${item.productId}: ${item.quantity} x $${item.price}</p>`
          ).join('')}
          <p><strong>Total: $${totalAmount.toFixed(2)}</strong></p>
        </div>
        
        <div style="background: #e8f4f8; padding: 15px; margin: 20px 0;">
          <h3>Shipping Information</h3>
          <p><strong>Carrier:</strong> ${data.carrier}</p>
          <p><strong>Tracking Number:</strong> ${data.trackingNumber}</p>
          <p><strong>Estimated Delivery:</strong> ${data.estimatedDelivery}</p>
        </div>
        
        <p>Thank you for your business!</p>
      </div>
    `;

    return { subject, body, html };
  }

  private async sendEmail(
    email: string,
    content: { subject: string; body: string; html: string }
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      // Simulate email service API call
      await new Promise(resolve => setTimeout(resolve, 80 + Math.random() * 80));

      // Simulate occasional email failures (3% chance)
      if (Math.random() < 0.03) {
        throw new Error('Email service temporarily unavailable');
      }

      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

      return { success: true, messageId };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  private async sendSMS(
    customerId: string,
    data: { orderId: string; trackingNumber: string; carrier: string }
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    // Simulate SMS service call
    await new Promise(resolve => setTimeout(resolve, 40 + Math.random() * 40));

    // Simulate occasional SMS failures (5% chance)
    if (Math.random() < 0.05) {
      return { success: false, error: 'SMS service unavailable' };
    }

    const messageId = `sms_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    return {
      success: true,
      messageId
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { InngestFunction } from '@torixtv/nestjs-inngest';
import { OrderData } from './order.service';

export interface OrderPaymentEvent {
  name: 'order.payment.required';
  data: OrderData;
}

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  error?: string;
  gatewayResponse?: string;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);


  @InngestFunction({
    id: 'process-payment',
    triggers: { event: 'order.payment.required' }
  })
  async processPayment(event: OrderPaymentEvent, step: any) {
    const { orderId, customerId, totalAmount, paymentMethod } = event.data;
    
    this.logger.log(
      `Processing payment for order ${orderId}, amount: $${totalAmount} - automatically traced`
    );

    const paymentResult = await step.run('charge-payment', () => {
      return this.chargeCustomer(event.data);
    });

    if (paymentResult.success) {
      this.logger.log(
        `Payment successful for order ${orderId}, transaction: ${paymentResult.transactionId}`
      );

      // Continue to inventory check
      await step.sendEvent('send-order-inventory-check', {
        name: 'order.inventory.check',
        data: {
          ...event.data,
          transactionId: paymentResult.transactionId
        }
      });

      return {
        success: true,
        transactionId: paymentResult.transactionId,
        status: 'payment_completed'
      };
    } else {
      this.logger.error(
        `Payment failed for order ${orderId}: ${paymentResult.error}`
      );

      // Handle payment failure
      await step.sendEvent('send-order-payment-failed', {
        name: 'order.payment.failed',
        data: {
          orderId,
          customerId,
          reason: paymentResult.error,
          amount: totalAmount
        }
      });

      return {
        success: false,
        error: paymentResult.error,
        status: 'payment_failed'
      };
    }
  }

  /**
   * Charge customer using external payment gateway
   * This is automatically traced when called from a step
   */
  private async chargeCustomer(orderData: OrderData): Promise<PaymentResult> {
    try {
      // Simulate external payment API call with network latency
      await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1000));
      
      // Simulate payment processing logic
      const shouldSucceed = Math.random() > 0.1; // 90% success rate
      
      if (shouldSucceed) {
        const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        return {
          success: true,
          transactionId,
          gatewayResponse: 'approved'
        };
      } else {
        return {
          success: false,
          error: 'Card declined - insufficient funds',
          gatewayResponse: 'declined'
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      return {
        success: false,
        error: `Payment gateway error: ${errorMessage}`,
        gatewayResponse: 'error'
      };
    }
  }
}

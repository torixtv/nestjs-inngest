import { Injectable, Logger } from '@nestjs/common';
import { InngestFunction, InngestTracingService } from '@torixtv/nestjs-inngest';
import { OrderData } from './order.service';

export interface OrderInventoryEvent {
  name: 'order.inventory.check';
  data: OrderData & { transactionId: string };
}

export interface InventoryResult {
  success: boolean;
  availableItems?: Array<{
    productId: string;
    availableQuantity: number;
    reserved: boolean;
  }>;
  unavailableItems?: Array<{
    productId: string;
    requestedQuantity: number;
    availableQuantity: number;
  }>;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  // Simulate inventory database
  private inventory = new Map([
    ['prod_456', { available: 100, reserved: 0 }],
    ['prod_789', { available: 50, reserved: 0 }],
    ['prod_123', { available: 25, reserved: 0 }],
  ]);

  constructor(
    private readonly tracingService: InngestTracingService
  ) {}

  @InngestFunction({
    id: 'check-inventory',
    triggers: { event: 'order.inventory.check' }
  })
  async checkInventory(event: OrderInventoryEvent, step: any) {
    const { orderId, items, transactionId } = event.data;
    
    this.logger.log(
      `Checking inventory for order ${orderId} with ${items.length} items - automatically traced`
    );

    // Check item availability
    const availabilityResult = await step.run('check-availability', () => {
      return this.checkItemAvailability(items);
    });

    if (!availabilityResult.success) {
      this.logger.warn(
        `Inventory insufficient for order ${orderId}:`,
        availabilityResult.unavailableItems
      );

      // Send inventory failure event
      await step.sendEvent('send-order-inventory-insufficient', {
        name: 'order.inventory.insufficient',
        data: {
          orderId,
          transactionId,
          unavailableItems: availabilityResult.unavailableItems
        }
      });

      return {
        success: false,
        status: 'inventory_insufficient',
        unavailableItems: availabilityResult.unavailableItems
      };
    }

    // Reserve items
    const reservationResult = await step.run('reserve-items', () => {
      return this.reserveItems(orderId, items);
    });

    if (reservationResult.success) {
      this.logger.log(`Items reserved for order ${orderId}`);

      // Continue to fulfillment
      await step.sendEvent('send-order-fulfillment-ready', {
        name: 'order.fulfillment.ready',
        data: {
          ...event.data,
          reservationId: `rsv_${orderId}_${Date.now()}`
        }
      });

      return {
        success: true,
        status: 'items_reserved',
        reservedItems: reservationResult.availableItems
      };
    } else {
      this.logger.error(`Failed to reserve items for order ${orderId}`);

      await step.sendEvent('send-order-reservation-failed', {
        name: 'order.inventory.reservation_failed',
        data: { orderId, transactionId, reason: 'Reservation system error' }
      });

      return {
        success: false,
        status: 'reservation_failed'
      };
    }
  }

  private async checkItemAvailability(items: Array<{ productId: string; quantity: number }>): Promise<InventoryResult> {
    // Simulate database query latency
    await new Promise(resolve => setTimeout(resolve, 150 + Math.random() * 100));

    const availableItems: Array<{
      productId: string;
      availableQuantity: number;
      reserved: boolean;
    }> = [];

    const unavailableItems: Array<{
      productId: string;
      requestedQuantity: number;
      availableQuantity: number;
    }> = [];

    for (const item of items) {
      const inventoryItem = this.inventory.get(item.productId);
      
      if (!inventoryItem) {
        unavailableItems.push({
          productId: item.productId,
          requestedQuantity: item.quantity,
          availableQuantity: 0
        });
        continue;
      }

      const availableQuantity = inventoryItem.available - inventoryItem.reserved;
      
      if (availableQuantity >= item.quantity) {
        availableItems.push({
          productId: item.productId,
          availableQuantity,
          reserved: false
        });
      } else {
        unavailableItems.push({
          productId: item.productId,
          requestedQuantity: item.quantity,
          availableQuantity
        });
      }
    }

    return {
      success: unavailableItems.length === 0,
      availableItems: unavailableItems.length === 0 ? availableItems : undefined,
      unavailableItems: unavailableItems.length > 0 ? unavailableItems : undefined
    };
  }

  private async reserveItems(
    orderId: string,
    items: Array<{ productId: string; quantity: number }>
  ): Promise<InventoryResult> {
    // Simulate reservation system latency
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 100));

    const reservedItems: Array<{
      productId: string;
      availableQuantity: number;
      reserved: boolean;
    }> = [];

    try {
      // Simulate potential reservation failure (5% chance)
      if (Math.random() < 0.05) {
        throw new Error('Inventory reservation system temporarily unavailable');
      }

      // Reserve each item
      for (const item of items) {
        const inventoryItem = this.inventory.get(item.productId);
        if (inventoryItem && inventoryItem.available - inventoryItem.reserved >= item.quantity) {
          inventoryItem.reserved += item.quantity;
          
          reservedItems.push({
            productId: item.productId,
            availableQuantity: inventoryItem.available - inventoryItem.reserved,
            reserved: true
          });
        }
      }

      return {
        success: true,
        availableItems: reservedItems
      };

    } catch (error) {
      return {
        success: false
      };
    }
  }
}

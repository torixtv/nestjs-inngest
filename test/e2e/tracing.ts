import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const traceLogBuffer: string[] = [];
export const tracingInitMessage = '🚀 OpenTelemetry initialized with console exporter for e2e testing';

function traceLog(message: string) {
  traceLogBuffer.push(message);
  console.log(message);
}

export function getTraceLogBuffer() {
  return [...traceLogBuffer];
}

export function clearTraceLogBuffer() {
  traceLogBuffer.length = 0;
}

// Enhanced console exporter for e2e testing with detailed trace hierarchies
const consoleExporter = {
  export: (spans: any[], resultCallback: any) => {
    traceLog('\n🔍 TRACING: OpenTelemetry Spans Export:');
    traceLog('='.repeat(80));
    
    // Group spans by trace ID to show hierarchies
    const traceGroups = new Map<string, any[]>();
    spans.forEach(span => {
      const traceId = span.spanContext().traceId;
      if (!traceGroups.has(traceId)) {
        traceGroups.set(traceId, []);
      }
      traceGroups.get(traceId)!.push(span);
    });
    
    // Display each trace group with hierarchy
    traceGroups.forEach((traceSpans, traceId) => {
      traceLog(`\n📊 Trace: ${traceId}`);
      traceLog('-'.repeat(60));
      
      // Sort spans by start time to show execution order
      const sortedSpans = traceSpans.sort((a, b) => {
        const aTime = a.startTime[0] * 1e9 + a.startTime[1];
        const bTime = b.startTime[0] * 1e9 + b.startTime[1];
        return aTime - bTime;
      });
      
      sortedSpans.forEach((span, index) => {
        const spanContext = span.spanContext();
        const duration = (span.endTime[0] - span.startTime[0]) * 1000 + (span.endTime[1] - span.startTime[1]) / 1000000;
        const attributes = span.attributes || {};
        
        // Determine span type and icon
        let icon = '⚡';
        let indentation = '';
        if (span.name.includes('.execution')) {
          icon = '🎯';
          indentation = '';
        } else if (span.name.includes('.step.')) {
          icon = '🔧';
          indentation = '  ';
        } else if (span.name.includes('POST') || span.name.includes('GET')) {
          icon = '🌐';
          indentation = '    ';
        }
        
        traceLog(`${indentation}${icon} ${span.name}`);
        traceLog(`${indentation}   ⏱️  Duration: ${duration.toFixed(2)}ms`);
        traceLog(`${indentation}   🔗 SpanId: ${spanContext.spanId}`);
        
        // Show key attributes
        const keyAttributes: Record<string, any> = {};
        Object.keys(attributes).forEach(key => {
          if (key.startsWith('inngest.') || 
              key.startsWith('user.') || 
              key.startsWith('operation.') ||
              key === 'http.method' ||
              key === 'http.route' ||
              key.includes('success') ||
              key.includes('error')) {
            keyAttributes[key] = attributes[key];
          }
        });
        
        if (Object.keys(keyAttributes).length > 0) {
          traceLog(`${indentation}   📋 Key Attributes:`);
          Object.entries(keyAttributes).forEach(([key, value]) => {
            const displayKey = key.replace(/^inngest\./, '').replace(/^operation\./, 'op.');
            traceLog(`${indentation}      ${displayKey}: ${value}`);
          });
        }
        
        // Show events if any
        if (span.events && span.events.length > 0) {
          traceLog(`${indentation}   🎭 Events: ${span.events.map((e: any) => e.name).join(', ')}`);
        }
        
        // Show status if error
        if (span.status && span.status.code === 2) {
          traceLog(`${indentation}   ❌ Status: ERROR - ${span.status.message || 'Unknown error'}`);
        }
        
        if (index < sortedSpans.length - 1) {
          traceLog(`${indentation}   │`);
        }
      });
      
      traceLog('-'.repeat(60));
      traceLog(`✅ Trace complete (${traceSpans.length} spans)`);
    });
    
    traceLog('\n' + '='.repeat(80));
    traceLog(`🎯 Export Summary: ${spans.length} spans across ${traceGroups.size} traces`);
    traceLog('🎉 End of spans export\n');
    resultCallback({ code: 0 }); // Success
  },
  shutdown: () => Promise.resolve()
};

// Initialize OpenTelemetry with console exporter for e2e testing
const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: 'nestjs-inngest-e2e-test',
    [ATTR_SERVICE_VERSION]: '1.0.0',
  }),
  traceExporter: consoleExporter,
  instrumentations: [getNodeAutoInstrumentations({
    // Disable some instrumentations to reduce noise
    '@opentelemetry/instrumentation-fs': {
      enabled: false,
    },
  })],
});

// Start OpenTelemetry SDK
sdk.start();

traceLog(tracingInitMessage);

// Export for cleanup if needed
export { sdk };

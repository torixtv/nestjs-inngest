import { Injectable, Logger } from '@nestjs/common';
import { 
  InngestService, 
  InngestFunction, 
  InngestCron,
  Retries,
  RateLimit 
} from '../../../../src/index';
import { v4 as uuidv4 } from 'uuid';
import { AppEvents, HealthMetrics } from '../types';

interface SystemAlert {
  id: string;
  type: 'database' | 'memory' | 'cpu' | 'disk' | 'external_api';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  createdAt: Date;
  resolvedAt?: Date;
  isActive: boolean;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  
  // In-memory storage for demo
  private alerts: Map<string, SystemAlert> = new Map();
  private healthHistory: HealthMetrics[] = [];
  private lastHealthCheck?: Date;

  constructor(private readonly inngestService: InngestService) {}

  // ============================================================================
  // INNGEST SCHEDULED FUNCTIONS
  // ============================================================================

  /**
   * Comprehensive system health check - runs every 5 minutes
   */
  @InngestCron('system-health-check', '*/5 * * * *')
  @Retries(2) // Retry health checks if they fail
  async performHealthCheck({ event, step }: { event: any; step: any }) {
    this.logger.log('🏥 Starting comprehensive system health check');
    const checkStartTime = new Date();

    try {
      // Step 1: Check database connectivity
      const databaseHealth = await step.run('check-database-health', async () => {
        this.logger.log('🗄️ Checking database connectivity');
        await this.simulateDelay(200);
        
        // Simulate database health check
        const responseTime = Math.floor(Math.random() * 150) + 10; // 10-160ms
        const isHealthy = Math.random() > 0.02; // 98% uptime
        
        return {
          isConnected: isHealthy,
          responseTime,
          status: isHealthy ? 'healthy' : 'down',
          lastChecked: new Date().toISOString(),
        };
      });

      // Step 2: Check system resources (CPU, Memory, Disk)
      const resourceHealth = await step.run('check-system-resources', async () => {
        this.logger.log('💻 Checking system resources');
        await this.simulateDelay(150);
        
        // Simulate resource metrics
        const cpuUsage = Math.floor(Math.random() * 100);
        const memoryUsage = Math.floor(Math.random() * 90) + 10; // 10-100%
        const diskUsage = Math.floor(Math.random() * 80) + 10;   // 10-90%
        
        return {
          cpu: {
            usage: cpuUsage,
            cores: 8,
            status: cpuUsage > 80 ? 'high' : cpuUsage > 60 ? 'medium' : 'low',
          },
          memory: {
            usage: memoryUsage,
            total: 16384, // 16GB in MB
            available: Math.floor(16384 * (100 - memoryUsage) / 100),
            status: memoryUsage > 85 ? 'high' : memoryUsage > 70 ? 'medium' : 'low',
          },
          disk: {
            usage: diskUsage,
            total: 512000, // 512GB in MB
            available: Math.floor(512000 * (100 - diskUsage) / 100),
            status: diskUsage > 90 ? 'high' : diskUsage > 75 ? 'medium' : 'low',
          },
        };
      });

      // Step 3: Check external API dependencies
      const externalApiHealth = await step.run('check-external-apis', async () => {
        this.logger.log('🌐 Checking external API dependencies');
        await this.simulateDelay(300);
        
        const apis = [
          { name: 'payment-gateway', url: 'https://api.stripe.com' },
          { name: 'email-service', url: 'https://api.sendgrid.com' },
          { name: 'storage-service', url: 'https://api.aws.com' },
          { name: 'analytics-service', url: 'https://api.mixpanel.com' },
        ];
        
        const results = [];
        
        for (const api of apis) {
          const responseTime = Math.floor(Math.random() * 500) + 50; // 50-550ms
          const isHealthy = Math.random() > 0.05; // 95% uptime
          
          results.push({
            name: api.name,
            status: isHealthy ? 'healthy' : Math.random() > 0.5 ? 'degraded' : 'down',
            responseTime,
            lastCheck: new Date(),
          });
        }
        
        return results;
      });

      // Step 4: Evaluate overall system health
      const healthEvaluation = await step.run('evaluate-system-health', async () => {
        this.logger.log('📊 Evaluating overall system health');
        await this.simulateDelay(100);
        
        const issues = [];
        let overallScore = 100;
        
        // Evaluate database
        if (!databaseHealth.isConnected) {
          issues.push({ type: 'database', severity: 'critical', message: 'Database is unreachable' });
          overallScore -= 40;
        } else if (databaseHealth.responseTime > 100) {
          issues.push({ type: 'database', severity: 'medium', message: `Slow database response: ${databaseHealth.responseTime}ms` });
          overallScore -= 10;
        }
        
        // Evaluate CPU
        if (resourceHealth.cpu.usage > 90) {
          issues.push({ type: 'cpu', severity: 'high', message: `High CPU usage: ${resourceHealth.cpu.usage}%` });
          overallScore -= 20;
        } else if (resourceHealth.cpu.usage > 80) {
          issues.push({ type: 'cpu', severity: 'medium', message: `Elevated CPU usage: ${resourceHealth.cpu.usage}%` });
          overallScore -= 10;
        }
        
        // Evaluate Memory
        if (resourceHealth.memory.usage > 90) {
          issues.push({ type: 'memory', severity: 'high', message: `High memory usage: ${resourceHealth.memory.usage}%` });
          overallScore -= 20;
        } else if (resourceHealth.memory.usage > 80) {
          issues.push({ type: 'memory', severity: 'medium', message: `Elevated memory usage: ${resourceHealth.memory.usage}%` });
          overallScore -= 10;
        }
        
        // Evaluate Disk
        if (resourceHealth.disk.usage > 95) {
          issues.push({ type: 'disk', severity: 'critical', message: `Critical disk usage: ${resourceHealth.disk.usage}%` });
          overallScore -= 30;
        } else if (resourceHealth.disk.usage > 85) {
          issues.push({ type: 'disk', severity: 'high', message: `High disk usage: ${resourceHealth.disk.usage}%` });
          overallScore -= 15;
        }
        
        // Evaluate External APIs
        const downApis = externalApiHealth.filter((api: any) => api.status === 'down');
        const degradedApis = externalApiHealth.filter((api: any) => api.status === 'degraded');
        
        for (const api of downApis) {
          issues.push({ type: 'external_api', severity: 'high', message: `${api.name} is down` });
          overallScore -= 15;
        }
        
        for (const api of degradedApis) {
          issues.push({ type: 'external_api', severity: 'medium', message: `${api.name} is degraded` });
          overallScore -= 8;
        }
        
        return {
          overallScore: Math.max(0, overallScore),
          status: overallScore >= 90 ? 'healthy' : overallScore >= 70 ? 'degraded' : 'unhealthy',
          issues,
          issueCount: issues.length,
        };
      });

      // Step 5: Create alerts for any critical issues
      if (healthEvaluation.issues.length > 0) {
        await step.run('process-health-alerts', async () => {
          this.logger.log(`⚠️ Processing ${healthEvaluation.issues.length} health issues`);
          await this.simulateDelay(200);
          
          for (const issue of healthEvaluation.issues) {
            if (issue.severity === 'critical' || issue.severity === 'high') {
              // Send health alert
              await this.inngestService.send({
                name: 'system.health.alert',
                data: {
                  alertType: issue.type as any,
                  severity: issue.severity as any,
                  message: issue.message,
                  metrics: {
                    cpu: resourceHealth.cpu.usage,
                    memory: resourceHealth.memory.usage,
                    disk: resourceHealth.disk.usage,
                    dbResponseTime: databaseHealth.responseTime,
                  },
                  timestamp: new Date().toISOString(),
                },
              });
              
              // Store alert
              const alert: SystemAlert = {
                id: uuidv4(),
                type: issue.type as any,
                severity: issue.severity as any,
                message: issue.message,
                createdAt: new Date(),
                isActive: true,
              };
              
              this.alerts.set(alert.id, alert);
            }
          }
          
          return { 
            alertsGenerated: healthEvaluation.issues.filter((i: any) => i.severity === 'critical' || i.severity === 'high').length,
          };
        });
      }

      // Step 6: Store health metrics
      const healthRecord = await step.run('store-health-metrics', async () => {
        this.logger.log('💾 Storing health metrics');
        await this.simulateDelay(100);
        
        const metrics: HealthMetrics = {
          cpu: resourceHealth.cpu,
          memory: resourceHealth.memory,
          disk: resourceHealth.disk,
          database: {
            isConnected: databaseHealth.isConnected,
            responseTime: databaseHealth.responseTime,
          },
          externalApis: externalApiHealth,
        };
        
        this.healthHistory.push(metrics);
        
        // Keep only last 100 records
        if (this.healthHistory.length > 100) {
          this.healthHistory = this.healthHistory.slice(-100);
        }
        
        this.lastHealthCheck = new Date();
        
        return { 
          stored: true, 
          historySize: this.healthHistory.length,
        };
      });

      const checkDuration = new Date().getTime() - checkStartTime.getTime();
      this.logger.log(`✅ Health check completed in ${checkDuration}ms - Status: ${healthEvaluation.status} (Score: ${healthEvaluation.overallScore}/100)`);

      return {
        success: true,
        status: healthEvaluation.status,
        overallScore: healthEvaluation.overallScore,
        issuesFound: healthEvaluation.issueCount,
        checkDuration,
        timestamp: checkStartTime.toISOString(),
        components: {
          database: databaseHealth,
          resources: resourceHealth,
          externalApis: externalApiHealth.length,
          alertsGenerated: healthEvaluation.issues.filter((i: any) => i.severity === 'critical' || i.severity === 'high').length,
        },
      };

    } catch (error) {
      this.logger.error(`❌ Health check failed: ${error.message}`, error.stack);
      
      // Send critical alert about health check failure
      await step.run('send-health-check-failure-alert', async () => {
        await this.inngestService.send({
          name: 'system.health.alert',
          data: {
            alertType: 'external_api', // Health check system itself
            severity: 'critical',
            message: `Health check system failed: ${error.message}`,
            metrics: {},
            timestamp: new Date().toISOString(),
          },
        });
        
        return { failureAlertSent: true };
      });
      
      throw error;
    }
  }

  /**
   * Process health alerts and send notifications
   * Triggered by system.health.alert events
   */
  @InngestFunction({
    id: 'process-health-alert',
    name: 'Process Health Alert',
    triggers: { event: 'system.health.alert' },
  })
  @RateLimit(20, '5m') // Limit alerts to prevent spam
  async processHealthAlert({ event, step }: { event: AppEvents['system.health.alert']; step: any }) {
    const { alertType, severity, message, metrics, timestamp } = event.data;
    this.logger.log(`🚨 Processing health alert: ${severity} ${alertType} - ${message}`);

    // Step 1: Determine notification strategy based on severity
    const notificationPlan = await step.run('plan-alert-notifications', async () => {
      this.logger.log(`📋 Planning notifications for ${severity} alert`);
      await this.simulateDelay(100);
      
      let notificationTargets: string[] = [];
      let escalationDelay: string | null = null;
      let requiresImmediateAction = false;
      
      switch (severity) {
        case 'critical':
          notificationTargets = ['on-call', 'team-lead', 'infrastructure'];
          requiresImmediateAction = true;
          escalationDelay = '5m'; // Escalate if not acknowledged in 5 minutes
          break;
        case 'high':
          notificationTargets = ['on-call', 'infrastructure'];
          escalationDelay = '15m';
          break;
        case 'medium':
          notificationTargets = ['infrastructure'];
          escalationDelay = '1h';
          break;
        case 'low':
          notificationTargets = ['infrastructure'];
          escalationDelay = null; // No escalation for low severity
          break;
      }
      
      return {
        targets: notificationTargets,
        escalationDelay,
        requiresImmediateAction,
        priority: severity === 'critical' ? 'high' : 'normal',
      };
    });

    // Step 2: Send immediate notifications
    await step.run('send-alert-notifications', async () => {
      this.logger.log(`📧 Sending alert notifications to: ${notificationPlan.targets.join(', ')}`);
      await this.simulateDelay(200);
      
      for (const target of notificationPlan.targets) {
        const recipientEmail = this.getRecipientEmail(target);
        
        await this.inngestService.send({
          name: 'notification.email.send',
          data: {
            to: recipientEmail,
            subject: `🚨 ${severity.toUpperCase()} Alert: ${alertType}`,
            template: 'system-alert',
            templateData: {
              severity,
              alertType,
              message,
              metrics: JSON.stringify(metrics, null, 2),
              timestamp,
              dashboardUrl: 'https://monitoring.example.com/dashboard',
            },
            priority: notificationPlan.priority as 'high' | 'normal',
          },
        });
      }
      
      return { 
        notificationsSent: notificationPlan.targets.length,
        targets: notificationPlan.targets,
      };
    });

    // Step 3: Set up escalation if required
    if (notificationPlan.escalationDelay && severity !== 'low') {
      await step.run('setup-alert-escalation', async () => {
        this.logger.log(`⏰ Setting up escalation in ${notificationPlan.escalationDelay}`);
        await this.simulateDelay(100);
        
        // In a real implementation, you would:
        // 1. Wait for the escalation delay
        // 2. Check if the alert was acknowledged
        // 3. If not acknowledged, escalate to higher level
        
        return {
          escalationScheduled: true,
          escalationDelay: notificationPlan.escalationDelay,
        };
      });
    }

    // Step 4: Create incident record for critical/high severity alerts
    if (severity === 'critical' || severity === 'high') {
      await step.run('create-incident-record', async () => {
        this.logger.log(`📝 Creating incident record for ${severity} alert`);
        await this.simulateDelay(150);
        
        const incidentId = `INC-${Date.now()}`;
        
        // In a real system, you would create an incident in your ticketing system
        this.logger.log(`🎫 Created incident: ${incidentId}`);
        
        return {
          incidentCreated: true,
          incidentId,
          status: 'open',
          assignedTo: notificationPlan.targets[0], // Assign to primary on-call
        };
      });
    }

    return {
      success: true,
      alertProcessed: true,
      severity,
      alertType,
      notificationsSent: notificationPlan.targets.length,
      escalationScheduled: Boolean(notificationPlan.escalationDelay),
      incidentCreated: severity === 'critical' || severity === 'high',
    };
  }

  /**
   * Weekly system cleanup and maintenance
   * Runs every Sunday at 3 AM
   */
  @InngestCron('weekly-system-maintenance', '0 3 * * 0')
  async performWeeklyMaintenance({ event, step }: { event: any; step: any }) {
    this.logger.log('🧹 Starting weekly system maintenance');

    // Step 1: Cleanup old health records
    await step.run('cleanup-old-health-records', async () => {
      this.logger.log('🗑️ Cleaning up old health records');
      await this.simulateDelay(500);
      
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      
      const initialCount = this.healthHistory.length;
      // Keep only records from the last week (this is simplified for demo)
      this.healthHistory = this.healthHistory.slice(-336); // 7 days * 24 hours * 2 (every 30 min)
      
      const removedCount = initialCount - this.healthHistory.length;
      
      return { 
        removedRecords: removedCount,
        remainingRecords: this.healthHistory.length,
      };
    });

    // Step 2: Resolve old alerts
    await step.run('cleanup-old-alerts', async () => {
      this.logger.log('✅ Auto-resolving old alerts');
      await this.simulateDelay(300);
      
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      
      let resolvedCount = 0;
      for (const alert of this.alerts.values()) {
        if (alert.isActive && alert.createdAt < threeDaysAgo) {
          alert.isActive = false;
          alert.resolvedAt = new Date();
          resolvedCount++;
        }
      }
      
      return { 
        resolvedAlerts: resolvedCount,
        totalAlerts: this.alerts.size,
      };
    });

    // Step 3: Generate weekly health report
    const weeklyReport = await step.run('generate-weekly-report', async () => {
      this.logger.log('📊 Generating weekly health report');
      await this.simulateDelay(1000);
      
      const report = this.generateHealthReport();
      
      // Send weekly report to infrastructure team
      await this.inngestService.send({
        name: 'notification.email.send',
        data: {
          to: this.getRecipientEmail('infrastructure'),
          subject: 'Weekly System Health Report',
          template: 'weekly-health-report',
          templateData: {
            ...report,
            reportDate: new Date().toISOString(),
          },
          priority: 'normal',
        },
      });
      
      return report;
    });

    // Step 4: Send maintenance completion notification
    await step.run('send-maintenance-completion', async () => {
      this.logger.log('✅ Sending maintenance completion notification');
      await this.simulateDelay(100);
      
      await this.inngestService.send({
        name: 'system.cleanup.completed',
        data: {
          cleanupType: 'weekly_maintenance',
          itemsProcessed: weeklyReport.totalHealthChecks,
          completedAt: new Date().toISOString(),
        },
      });
      
      return { notificationSent: true };
    });

    this.logger.log('✅ Weekly maintenance completed');

    return {
      success: true,
      maintenanceType: 'weekly',
      completedAt: new Date().toISOString(),
      summary: {
        healthRecordsProcessed: weeklyReport.totalHealthChecks,
        alertsResolved: 0, // Would be filled by actual cleanup step
        reportsGenerated: 1,
      },
    };
  }

  // ============================================================================
  // SERVICE METHODS (for REST API)
  // ============================================================================

  getCurrentHealth(): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    lastCheck?: Date;
    activeAlerts: number;
    recentMetrics?: HealthMetrics;
  } {
    const activeAlerts = Array.from(this.alerts.values()).filter(a => a.isActive).length;
    const recentMetrics = this.healthHistory[this.healthHistory.length - 1];
    
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (activeAlerts > 5) status = 'unhealthy';
    else if (activeAlerts > 2) status = 'degraded';
    
    return {
      status,
      lastCheck: this.lastHealthCheck,
      activeAlerts,
      recentMetrics,
    };
  }

  isSystemReady(): boolean {
    const currentHealth = this.getCurrentHealth();
    const activeAlerts = this.getActiveAlerts();
    
    // System is ready if status is healthy or degraded (not unhealthy)
    // and there are no critical alerts
    const hasCriticalAlerts = activeAlerts.some(alert => alert.severity === 'critical');
    
    return currentHealth.status !== 'unhealthy' && !hasCriticalAlerts;
  }

  getActiveAlerts(): SystemAlert[] {
    return Array.from(this.alerts.values()).filter(alert => alert.isActive);
  }

  getHealthHistory(hours: number = 24): HealthMetrics[] {
    // Return last N hours of health data (simplified)
    const maxRecords = Math.min(hours * 12, this.healthHistory.length); // Assuming checks every 5 minutes
    return this.healthHistory.slice(-maxRecords);
  }

  generateHealthReport() {
    const activeAlerts = this.getActiveAlerts();
    const recentMetrics = this.healthHistory.slice(-288); // Last 24 hours (assuming 5-min checks)
    
    // Calculate averages
    const avgCpu = recentMetrics.reduce((sum, m) => sum + m.cpu.usage, 0) / recentMetrics.length;
    const avgMemory = recentMetrics.reduce((sum, m) => sum + m.memory.usage, 0) / recentMetrics.length;
    const avgDisk = recentMetrics.reduce((sum, m) => sum + m.disk.usage, 0) / recentMetrics.length;
    
    return {
      reportDate: new Date().toISOString(),
      totalHealthChecks: this.healthHistory.length,
      activeAlerts: activeAlerts.length,
      avgCpuUsage: Math.round(avgCpu),
      avgMemoryUsage: Math.round(avgMemory),
      avgDiskUsage: Math.round(avgDisk),
      uptimeScore: Math.max(0, 100 - (activeAlerts.length * 5)), // Simple scoring
      criticalIssues: activeAlerts.filter(a => a.severity === 'critical').length,
      highIssues: activeAlerts.filter(a => a.severity === 'high').length,
    };
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private async simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getRecipientEmail(target: string): string {
    const emailMap: Record<string, string> = {
      'on-call': 'oncall@example.com',
      'team-lead': 'teamlead@example.com',
      'infrastructure': 'infrastructure@example.com',
      'security': 'security@example.com',
    };
    
    return emailMap[target] || 'admin@example.com';
  }
}

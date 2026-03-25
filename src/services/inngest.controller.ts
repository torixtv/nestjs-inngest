import { Controller, Get, Post, Put, Req, Res, Logger, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { serve } from 'inngest/express';
import { InngestService } from './inngest.service';

// Create a controller factory that uses the configured path
export function createInngestController(path: string = 'inngest') {
  // Ensure path doesn't start with slash for decorator
  const cleanPath = path.replace(/^\//, '');

  @Controller(cleanPath)
  class DynamicInngestController {
    public readonly logger = new Logger(`InngestController(${cleanPath})`);
    public handler: any;

    constructor(public readonly inngestService: InngestService) {
      this.initializeHandler();
    }

    public initializeHandler() {
      const options = this.inngestService.getOptions();

      // In connect mode, don't initialize serve handler — functions are invoked via WebSocket
      if (options.mode === 'connect') {
        this.handler = (_req: Request, res: Response) => {
          res.status(HttpStatus.NOT_FOUND).json({
            error: 'Not available',
            message: 'This app uses Inngest Connect mode. Serve endpoints are disabled.',
          });
        };
        this.logger.log('Connect mode detected — serve handler disabled');
        return;
      }

      const functions = this.inngestService.getFunctions();
      const client = this.inngestService.getClient();

      this.logger.debug(`Initializing handler with ${functions.length} functions`);
      this.logger.debug(
        `Functions: ${functions.map((f) => f.id || f.name || 'unnamed').join(', ')}`,
      );
      this.logger.debug(`Client ID: ${client.id}`);

      // Create the serve handler with configuration
      const serveOptions: any = {
        client,
        functions,
      };

      if (options.serveOrigin) {
        const port = options.servePort || process.env.PORT || 3000;
        const baseUrl =
          options.serveOrigin.startsWith('http://') || options.serveOrigin.startsWith('https://')
            ? options.serveOrigin
            : `http://${options.serveOrigin}:${port}`;
        serveOptions.serveOrigin = new URL(baseUrl).origin;
      }

      // Use servePath if provided, otherwise fallback to path
      // This allows separate internal (controller) and external (callback) paths
      const finalServePath = options.servePath || options.path;
      if (finalServePath) {
        serveOptions.servePath = `/${finalServePath.replace(/^\//, '')}`;
      }

      this.handler = serve(serveOptions);

      this.logger.log(
        `Inngest handler initialized with ${functions.length} functions at path: /${cleanPath}`,
      );
    }

    @Get()
    async handleGet(@Req() req: Request, @Res() res: Response) {
      this.initializeHandler();
      try {
        await this.handler(req, res);
      } catch (error) {
        this.logger.error(`Error handling GET request: ${error.message}`, error.stack);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          error: 'Internal server error',
          message: error.message,
        });
      }
    }

    @Post()
    async handlePost(@Req() req: Request, @Res() res: Response) {
      this.initializeHandler();
      try {
        await this.handler(req, res);
      } catch (error) {
        this.logger.error(`Error handling POST request: ${error.message}`, error.stack);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          error: 'Internal server error',
          message: error.message,
        });
      }
    }

    @Put()
    async handlePut(@Req() req: Request, @Res() res: Response) {
      this.initializeHandler();
      try {
        await this.handler(req, res);
      } catch (error) {
        this.logger.error(`Error handling PUT request: ${error.message}`, error.stack);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          error: 'Internal server error',
          message: error.message,
        });
      }
    }
  }

  return DynamicInngestController;
}

// Export a default controller for backward compatibility
export const InngestController: any = createInngestController();

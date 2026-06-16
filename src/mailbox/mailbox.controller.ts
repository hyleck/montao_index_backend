import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { AuthenticatedRequest, AuthGuard } from '../auth/auth.guard';
import { MailboxService, MailUploadFile } from './mailbox.service';

@Controller('api/mailbox')
@UseGuards(AuthGuard)
export class MailboxController {
  constructor(private readonly mailboxService: MailboxService) {}

  @Get('status')
  status(
    @Req() request: AuthenticatedRequest,
    @Query('mailboxEmail') mailboxEmail?: string,
  ) {
    return this.mailboxService.status(request, mailboxEmail);
  }

  @Post('config')
  configure(
    @Req() request: AuthenticatedRequest,
    @Body() body: { email?: string; password?: string },
  ) {
    return this.mailboxService.configure(request, body);
  }

  @Get('messages')
  messages(
    @Req() request: AuthenticatedRequest,
    @Query('box') box?: string,
    @Query('limit') limit?: string,
    @Query('mailboxEmail') mailboxEmail?: string,
  ) {
    return this.mailboxService.listMessages(request, { box, limit, mailboxEmail });
  }

  @Get('messages/:uid')
  message(
    @Req() request: AuthenticatedRequest,
    @Param('uid') uid: string,
    @Query('box') box?: string,
    @Query('mailboxEmail') mailboxEmail?: string,
  ) {
    return this.mailboxService.getMessage(request, uid, box, mailboxEmail);
  }

  @Patch('messages/:uid/read')
  markRead(
    @Req() request: AuthenticatedRequest,
    @Param('uid') uid: string,
    @Query('box') box?: string,
    @Query('mailboxEmail') mailboxEmail?: string,
  ) {
    return this.mailboxService.markRead(request, uid, box, mailboxEmail);
  }

  @Patch('messages/:uid/read-state')
  updateReadState(
    @Req() request: AuthenticatedRequest,
    @Param('uid') uid: string,
    @Query('box') box?: string,
    @Query('mailboxEmail') mailboxEmail?: string,
    @Body() body?: { read?: boolean },
  ) {
    return this.mailboxService.updateReadState(request, uid, body?.read === true, box, mailboxEmail);
  }

  @Patch('messages/:uid/move')
  moveMessage(
    @Req() request: AuthenticatedRequest,
    @Param('uid') uid: string,
    @Query('box') box?: string,
    @Query('mailboxEmail') mailboxEmail?: string,
    @Body() body?: { targetBox?: string },
  ) {
    return this.mailboxService.moveMessage(request, uid, body?.targetBox, box, mailboxEmail);
  }

  @Post('send')
  @UseInterceptors(
    FilesInterceptor('attachments', 10, {
      limits: {
        fileSize: 20 * 1024 * 1024,
      },
    }),
  )
  send(
    @Req() request: AuthenticatedRequest,
    @UploadedFiles() files: MailUploadFile[] = [],
    @Body()
    body: {
      mailboxEmail?: string;
      to?: string;
      cc?: string;
      bcc?: string;
      subject?: string;
      text?: string;
      html?: string;
    },
  ) {
    return this.mailboxService.send(request, body, files);
  }
}

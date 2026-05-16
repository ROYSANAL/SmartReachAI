import { NextRequest, NextResponse } from 'next/server';
import { WorkflowProcessor } from '../../../services/workflowProcessor';
import { TimeUtils } from '../../../utils/timeUtils';

const workflowProcessor = new WorkflowProcessor();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { workflow: string };
    const { workflow } = body;

    if (!TimeUtils.isWorkingHours()) {
      return NextResponse.json({
        error: 'Outside working hours',
        nextWorkingHour: TimeUtils.getNextWorkingHour().toISOString()
      }, { status: 400 });
    }

    switch (workflow) {
      case 'processNewLeads':
        await workflowProcessor.processNewLeads();
        break;
      case 'processLeadEnrichment':
        await workflowProcessor.processLeadEnrichment();
        break;
      case 'processPostLiking':
        await workflowProcessor.processPostLiking();
        break;
      case 'processPostCommenting':
        await workflowProcessor.processPostCommenting();
        break;
      case 'processSendInvitations':
        await workflowProcessor.processSendInvitations();
        break;
      case 'processSendMessages':
        await workflowProcessor.processSendMessages();
        break;
      default:
        return NextResponse.json(
          { error: 'Invalid workflow type' },
          { status: 400 }
        );
    }

    return NextResponse.json({ message: `${workflow} completed successfully` });
  } catch (error) {
    console.error('Workflow trigger error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
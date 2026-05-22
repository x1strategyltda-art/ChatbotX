import { anchoredPeriod, macRepository } from "@chatbotx.io/analytics"
import { type DatabaseClient, db } from "@chatbotx.io/database/client"
import { workspaceMemberRoles } from "@chatbotx.io/database/partials"
import {
  workspaceModel,
  workspaceUsageModel,
} from "@chatbotx.io/database/schema"
import type {
  OrganizationModel,
  WorkspaceModel,
} from "@chatbotx.io/database/types"
import { withCache } from "@chatbotx.io/redis"
import { createId } from "@chatbotx.io/utils"
import { BaseService } from "../base.service"
import { billingService } from "../billing/service"
import { notFoundException } from "../errors"
import { logger } from "../logger"
import { workspaceMemberService } from "../workspace-member/service"

type WorkspaceWhere = Partial<{ id: string; organizationId: string }>

class WorkspaceService extends BaseService {
  async findOrFail(props: {
    where: WorkspaceWhere
    tx?: DatabaseClient
  }): Promise<WorkspaceModel> {
    const workspace = await this.find(props)
    if (!workspace) {
      throw notFoundException("Workspace not found")
    }
    return workspace
  }

  async findById(props: {
    id: string
    tx?: DatabaseClient
  }): Promise<WorkspaceModel> {
    return await this.findOrFail({ where: { id: props.id }, tx: props.tx })
  }

  async find(props: {
    where: WorkspaceWhere
    tx?: DatabaseClient
  }): Promise<WorkspaceModel | undefined> {
    const { where, tx = db } = props
    return await withCache(
      `workspaces:${JSON.stringify(props.where)}`,
      async () =>
        await tx.query.workspaceModel.findFirst({
          where,
        }),
      {
        tags: ["workspaces"],
      },
    )
  }

  async create(props: {
    data: typeof workspaceModel.$inferInsert
    organization: OrganizationModel
    createdBy: string
    tx?: DatabaseClient
  }): Promise<WorkspaceModel> {
    const { data, tx = db } = props

    const [newWorkspace] = await tx
      .insert(workspaceModel)
      .values(data)
      .returning()

    // Create workspace usage
    await tx.insert(workspaceUsageModel).values({
      id: createId(),
      workspaceId: newWorkspace.id,
      maxContacts: props.organization.defaultMaxContacts,
    })

    // Create workspace member
    await workspaceMemberService.create({
      tx,
      data: {
        userId: props.createdBy,
        workspaceId: newWorkspace.id,
        role: workspaceMemberRoles.enum.owner,
        permissions: {
          superAdmin: true,
          analytics: true,
          flows: true,
          contacts: true,
          onlyAssignedContacts: true,
          emailAndPhone: true,
          broadcast: true,
          ecommerce: true,
        },
        notificationTypes: {
          notifyAdmin: true,
          newMessageToHuman: true,
          newOrder: true,
        },
        notificationChannels: {
          messenger: true,
          email: true,
          telegram: true,
          browser: true,
        },
      },
    })

    await this.ensureMacRollup({
      workspaceId: newWorkspace.id,
      userId: props.createdBy,
      tx,
    })

    this.invalidateCacheTags([`users:${props.createdBy}:workspace-members`])

    return newWorkspace
  }

  /**
   * Front-loads the MAC rollup chain (`BillingMac` + `WorkspaceMac`) for a
   * brand-new workspace so the analytics counter is visible before the first
   * contact event. The lazy upsert in `MacTrackingService` would also create
   * these rows on first activity — this is a pre-provisioning shortcut so the
   * counter shows `0` immediately instead of "no row".
   *
   * Fails open: a MAC provisioning failure must never block workspace creation
   * (analytics observability is not a critical path). Errors are logged. The
   * billing record is per-user (`Billing.userId`); a user without one (e.g.
   * pre-billing-feature) simply skips MAC pre-provisioning — the lazy path
   * still covers them on first event.
   */
  private async ensureMacRollup(props: {
    workspaceId: string
    userId: string
    tx: DatabaseClient
  }): Promise<void> {
    try {
      const billing = await billingService.find({
        userId: props.userId,
        tx: props.tx,
      })
      if (!billing) {
        return
      }

      const { start, end } = anchoredPeriod(new Date(), billing.periodStart)

      const billingMacIds = await macRepository.ensureBillingMac(
        [{ billingId: billing.id, periodStart: start, periodEnd: end }],
        props.tx,
      )
      const billingMacId = billingMacIds.values().next().value
      if (!billingMacId) {
        return
      }

      await macRepository.ensureWorkspaceMac(
        [{ workspaceId: props.workspaceId, billingMacId }],
        props.tx,
      )
    } catch (error) {
      logger.error(
        {
          workspaceId: props.workspaceId,
          userId: props.userId,
          error,
        },
        "Failed to pre-provision WorkspaceMac",
      )
    }
  }
}

export const workspaceService = new WorkspaceService()

"use client"

import { useParams } from "next/navigation"
import { useFormContext } from "react-hook-form"
import { DirectUploadOrInsertLink } from "@/components/direct-upload"

type EmailTextStepEditorProps = {
  parentName: string
}

export default function EmailTextStepEditor({
  parentName,
}: EmailTextStepEditorProps) {
  const params = useParams<{ workspaceId: string; flowId: string }>()
  const { getValues } = useFormContext()
  const stepId = getValues(`${parentName}.id`)

  return (
    <DirectUploadOrInsertLink
      fileType="image"
      parentName={parentName}
      uploadPath={`public/space/${params.workspaceId}/flows/${params.flowId}/steps/${stepId}`}
    />
  )
}

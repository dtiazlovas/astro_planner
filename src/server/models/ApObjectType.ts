export interface ApObjectType {
  id: number
  name: string
}

export type CreateApObjectTypeDto = Pick<ApObjectType, 'name'>
export type UpdateApObjectTypeDto = Partial<CreateApObjectTypeDto>

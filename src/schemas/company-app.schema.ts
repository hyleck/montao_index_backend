import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AppStatus = 'Online' | 'Revision' | 'Interna';
export type CompanyAppDocument = HydratedDocument<CompanyApp>;

@Schema({ timestamps: true })
export class CompanyApp {
  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  description!: string;

  @Prop({ required: true })
  category!: string;

  @Prop({ required: true })
  group!: string;

  @Prop({ required: true })
  owner!: string;

  @Prop({ required: true })
  url!: string;

  @Prop({ enum: ['Online', 'Revision', 'Interna'], default: 'Online' })
  status!: AppStatus;

  @Prop({ required: true })
  initials!: string;

  @Prop({ required: true })
  icon!: string;

  @Prop({ default: 0 })
  order!: number;
}

export const CompanyAppSchema = SchemaFactory.createForClass(CompanyApp);

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserDocument = HydratedDocument<User>;

export interface DelegatedMailboxAccess {
  email: string;
  mailPasswordEncrypted: string;
  label?: string;
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, trim: true, lowercase: true })
  email!: string;

  @Prop({ required: true })
  passwordHash!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ default: 'admin' })
  role!: string;

  @Prop({ trim: true, lowercase: true })
  mailEmail?: string;

  @Prop()
  mailPasswordEncrypted?: string;

  @Prop({ type: [String], default: [] })
  delegatedMailboxes!: string[];

  @Prop({
    type: [
      {
        email: { type: String, required: true, trim: true, lowercase: true },
        mailPasswordEncrypted: { type: String, required: true },
        label: { type: String },
      },
    ],
    default: [],
  })
  delegatedMailboxAccesses!: DelegatedMailboxAccess[];
}

export const UserSchema = SchemaFactory.createForClass(User);
